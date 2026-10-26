import IORedis from "ioredis";
import { presenceKey } from "@botara/shared";

/**
 * Member presence, read side (adoption package #9).
 *
 * The realtime service writes `presence:{workspaceId}:{userId}` keys
 * (TTL in @botara/shared presence.ts) while a member holds an
 * authenticated socket; this reader answers "which of these members
 * have a live key" for GET /workspaces/:id/members.
 *
 * Presence is a HINT, never a dependency: any Redis failure (down,
 * timeout, refused) resolves to "everyone offline" rather than an
 * error, so the members list can never be taken down by presence.
 */
export interface PresenceReader {
  /** Subset of `userIds` with a live presence key in `workspaceId`. */
  onlineUserIds(workspaceId: string, userIds: string[]): Promise<Set<string>>;
}

/** Reader that reports nobody online - tests and Redis-less deployments. */
export const offlinePresenceReader: PresenceReader = {
  async onlineUserIds() {
    return new Set<string>();
  },
};

/** Core over an injectable key-existence probe (tests record the keys). */
export function createPresenceReader(
  exists: (keys: string[]) => Promise<boolean[]>,
): PresenceReader {
  return {
    async onlineUserIds(workspaceId, userIds) {
      if (userIds.length === 0) return new Set<string>();
      try {
        const flags = await exists(userIds.map((id) => presenceKey(workspaceId, id)));
        const online = new Set<string>();
        userIds.forEach((id, i) => {
          if (flags[i]) online.add(id);
        });
        return online;
      } catch {
        return new Set<string>();
      }
    },
  };
}

/**
 * Production reader: one lazily-created shared ioredis connection
 * (same pattern as the realtime publisher). A pipeline of EXISTS
 * commands keeps the members list at one round-trip; a broken
 * connection degrades to all-offline via the core's catch.
 */
export function createRedisPresenceReader(redisUrl: string): PresenceReader {
  let connection: IORedis | null = null;
  const getConnection = (): IORedis => {
    if (!connection) {
      connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      connection.on("error", () => { /* degraded to offline by the core catch */ });
    }
    return connection;
  };
  return createPresenceReader(async (keys) => {
    const pipeline = getConnection().pipeline();
    for (const key of keys) pipeline.exists(key);
    const results = await pipeline.exec();
    if (!results) return keys.map(() => false);
    return results.map(([err, value]) => !err && value === 1);
  });
}
