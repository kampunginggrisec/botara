import { z } from "zod";

/**
 * Central environment schema. Runtime-agnostic: parsing is lazy (getEnv)
 * so importing this module never crashes a process that only needs types.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT_API: z.coerce.number().int().positive().default(3000),
  PORT_REALTIME: z.coerce.number().int().positive().default(3002),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // Meta platform
  META_GRAPH_VERSION: z.string().default("v26.0"),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  THREADS_APP_ID: z.string().optional(),
  THREADS_APP_SECRET: z.string().optional(),

  // Cloudflare R2 (S3-compatible)
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("botara-media"),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),

  // Resend
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached) return cached;
  cached = envSchema.parse(source);
  return cached;
}
