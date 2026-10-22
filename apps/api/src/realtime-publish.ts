import IORedis from "ioredis";

/**
 * Realtime event publisher (inbox live updates).
 *
 * The API publishes lightweight "something changed in this inbox" events
 * on the Redis pub/sub channel `botara:realtime`; apps/realtime subscribes
 * and fans them out to the workspace's connected dashboard sockets. The
 * payload carries ids only - clients refetch through the REST API, so no
 * message content ever transits the bus.
 *
 * Publishing is FIRE-AND-FORGET by contract: a realtime outage must never
 * fail or delay message persistence, so implementations swallow errors.
 */

export const REALTIME_CHANNEL = "botara:realtime";

export interface InboxMessageEvent {
  type: "inbox.message";
  workspaceId: string;
  conversationId: string;
  direction: "in" | "out";
  messageId?: string;
}

export interface RealtimePublisher {
  publishInboxMessage(event: {
    workspaceId: string;
    conversationId: string;
    direction: "in" | "out";
    messageId?: string;
  }): Promise<void>;
}

/** Core over an injectable publish function (tests record the calls). */
export function createRealtimePublisher(
  publish: (channel: string, payload: string) => Promise<unknown>,
): RealtimePublisher {
  return {
    async publishInboxMessage(event) {
      try {
        const full: InboxMessageEvent = { type: "inbox.message", ...event };
        await publish(REALTIME_CHANNEL, JSON.stringify(full));
      } catch {
        // Fire-and-forget: realtime is a hint channel, never a dependency.
      }
    },
  };
}

/** No-op publisher for tests / deployments without a realtime service. */
export const noopRealtimePublisher: RealtimePublisher = {
  async publishInboxMessage() {},
};

/**
 * Production publisher: one lazily-created shared ioredis connection
 * (publishes are frequent and tiny - unlike the BullMQ enqueuers, which
 * connect per job by design).
 */
export function createRedisRealtimePublisher(redisUrl: string): RealtimePublisher {
  let connection: IORedis | null = null;
  const getConnection = (): IORedis => {
    if (!connection) {
      connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      connection.on("error", () => { /* surfaced nowhere - fire-and-forget */ });
    }
    return connection;
  };
  return createRealtimePublisher(async (channel, payload) => {
    await getConnection().publish(channel, payload);
  });
}
