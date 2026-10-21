import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let cached: { client: ReturnType<typeof postgres>; db: Database } | null = null;

/**
 * Lazy connection factory. Nothing connects at import time; the first
 * getDb() call reads DATABASE_URL and opens the pool.
 */
export function getDb(databaseUrl: string = process.env.DATABASE_URL ?? ""): Database {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (cached) return cached.db;
  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client, { schema });
  cached = { client, db };
  return db;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.client.end();
    cached = null;
  }
}
