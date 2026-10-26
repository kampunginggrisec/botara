import { AppError } from "@botara/shared";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

/**
 * Knowledge-base file upload: server-side text extraction for
 * POST /kb/documents/upload. Supported formats are PDF (text layer via
 * unpdf/pdf.js), DOCX (mammoth raw text), and plain TXT/MD (UTF-8). The
 * original file is NEVER stored - only the extracted text becomes a
 * normal KB document and flows through the existing chunk + embed
 * ingest pipeline. There is deliberately no OCR: a scanned/image-only
 * PDF has no text layer and is rejected with an honest 422.
 */

export interface KbUploadLimits {
  maxFileBytes: number;
  maxTextChars: number;
}

export const DEFAULT_KB_UPLOAD_LIMITS: KbUploadLimits = {
  /** 10 MB per file. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Stored text per document; longer extractions are truncated, never rejected. */
  maxTextChars: 200_000,
};

export type KbFileFormat = "pdf" | "docx" | "txt" | "md";

export interface KbExtraction {
  format: KbFileFormat;
  /** The text to store (trimmed, truncated to the cap when needed). */
  text: string;
  /** Characters stored, i.e. text.length after truncation. */
  chars: number;
  truncated: boolean;
}

const FORMAT_BY_EXTENSION: Record<string, KbFileFormat> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  md: "md",
};

export function kbFileFormatFor(filename: string): KbFileFormat | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_BY_EXTENSION[ext] ?? null;
}

/** Strip path components and control characters from a client-supplied filename. */
export function sanitizeUploadFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 255) || "upload";
}

/** Default document title for an upload: the filename without extension, tidied up. */
export function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  const tidy = stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return (tidy || "Uploaded document").slice(0, 300);
}

function hasMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const; // "PK\x03\x04" (DOCX is a ZIP)

async function extractRawText(format: KbFileFormat, bytes: Uint8Array): Promise<string> {
  switch (format) {
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const result = await extractText(pdf, { mergePages: true });
      return Array.isArray(result.text) ? result.text.join("\n") : result.text;
    }
    case "docx": {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return result.value;
    }
    case "txt":
    case "md":
      return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Validate an uploaded file and extract its text. Throws AppError with
 * the API's usual taxonomy: 400 VALIDATION for a wrong type / magic
 * mismatch / oversize file, 422 VALIDATION for a file that cannot be
 * read or yields no text.
 */
export async function extractKbFileText(
  input: { filename: string; bytes: Uint8Array },
  limits: KbUploadLimits,
): Promise<KbExtraction> {
  const { filename, bytes } = input;
  const format = kbFileFormatFor(filename);
  if (!format) {
    throw new AppError(
      "VALIDATION",
      `Unsupported file type for "${filename}". Knowledge-base uploads accept PDF, DOCX, TXT or MD files.`,
      { status: 400 },
    );
  }
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new AppError(
      "VALIDATION",
      `File is too large: ${bytes.byteLength} bytes exceeds the ${limits.maxFileBytes}-byte (10 MB) upload limit.`,
      { status: 400, details: { maxFileBytes: limits.maxFileBytes } },
    );
  }
  if (format === "pdf" && !hasMagic(bytes, PDF_MAGIC)) {
    throw new AppError(
      "VALIDATION",
      "File has a .pdf name but does not start with a PDF header (%PDF-).",
      { status: 400 },
    );
  }
  if (format === "docx" && !hasMagic(bytes, ZIP_MAGIC)) {
    throw new AppError(
      "VALIDATION",
      "File has a .docx name but is not a ZIP-based Office document.",
      { status: 400 },
    );
  }

  let raw: string;
  try {
    raw = await extractRawText(format, bytes);
  } catch {
    throw new AppError(
      "VALIDATION",
      `Could not extract text from "${filename}": the file appears corrupt or unreadable.`,
      { status: 422 },
    );
  }

  const text = raw.trim();
  if (!text) {
    throw new AppError(
      "VALIDATION",
      `No extractable text in "${filename}". Scanned or image-only documents have no text layer, and OCR is not supported.`,
      { status: 422 },
    );
  }
  const truncated = text.length > limits.maxTextChars;
  const stored = truncated ? text.slice(0, limits.maxTextChars) : text;
  return { format, text: stored, chars: stored.length, truncated };
}
