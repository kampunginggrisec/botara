import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "@botara/shared";

/**
 * Cloudflare R2 media helpers (ADR-006).
 *
 * URL rules that publishing channels depend on:
 * - Meta (Instagram/Threads/WhatsApp) fetches media from a PUBLIC https URL.
 *   Public URLs are built from R2_PUBLIC_BASE_URL, which must be a custom
 *   domain - NEVER an r2.dev URL (rate-limited, for development only).
 * - Presigned URLs are the exception path: they only validate on the
 *   S3-compatible endpoint (https://<account>.r2.cloudflarestorage.com),
 *   NOT on the custom public domain. Use presigned URLs for private objects,
 *   public URLs for anything a channel will fetch.
 */

export interface R2Env {
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_PUBLIC_BASE_URL?: string;
}

let client: S3Client | null = null;

export function getR2Client(env: R2Env = process.env as R2Env): S3Client {
  if (client) return client;
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new AppError("CONFIGURATION", "R2 credentials are not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return client;
}

export function publicUrl(key: string, env: R2Env = process.env as R2Env): string {
  const base = env.R2_PUBLIC_BASE_URL;
  if (!base) throw new AppError("CONFIGURATION", "R2_PUBLIC_BASE_URL is not set");
  if (base.includes("r2.dev")) {
    throw new AppError("CONFIGURATION", "R2_PUBLIC_BASE_URL must be a custom domain, not r2.dev (r2.dev is rate-limited and for development only)");
  }
  return `${base.replace(/\/$/, "")}/${key.replace(/^\//, "")}`;
}

export async function presignedPutUrl(key: string, contentType: string, expiresInSeconds = 900, env: R2Env = process.env as R2Env): Promise<string> {
  const s3 = getR2Client(env);
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: env.R2_BUCKET ?? "botara-media", Key: key, ContentType: contentType }), { expiresIn: expiresInSeconds });
}

export async function presignedGetUrl(key: string, expiresInSeconds = 900, env: R2Env = process.env as R2Env): Promise<string> {
  const s3 = getR2Client(env);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.R2_BUCKET ?? "botara-media", Key: key }), { expiresIn: expiresInSeconds });
}

/**
 * Server-side object write (worker flows: copying inbound email attachments
 * out of their temporary provider URLs into permanent R2 storage).
 * Returns the key plus the public URL when a public base is configured.
 */
export async function putObject(
  key: string,
  data: Uint8Array | ArrayBuffer | string,
  contentType: string,
  env: R2Env = process.env as R2Env,
): Promise<{ key: string; publicUrl?: string }> {
  const s3 = getR2Client(env);
  const body = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  await s3.send(new PutObjectCommand({
    Bucket: env.R2_BUCKET ?? "botara-media",
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  let url: string | undefined;
  try {
    url = publicUrl(key, env);
  } catch {
    url = undefined; // no public base configured - the key alone is the durable reference
  }
  return { key, publicUrl: url };
}
