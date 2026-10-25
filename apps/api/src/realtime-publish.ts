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

/**
 * A conversation's metadata changed without a new message (today:
 * assignment). Same fan-out contract as inbox.message - ids only, and
 * clients refetch the conversation list (and the open thread's header
 * state) through REST. Deliberately a distinct type so consumers that
 * only care about messages can ignore it.
 */
export interface InboxUpdateEvent {
  type: "inbox.update";
  workspaceId: string;
  conversationId: string;
}

export interface RealtimePublisher {
  publishInboxMessage(event: {
    workspaceId: string;
    conversationId: string;
    direction: "in" | "out";
    messageId?: string;
  }): Promise<void>;
  publishInboxUpdate(event: {
    workspaceId: string;
    conversationId: string;
  }): Promise<void>;
}

/** Core over an injectable publish function (tests record the calls). */
export function createRealtimePublisher(
  publish: (channel: string, payload: string) => Promise<unknown>,
): RealtimePublisher {
  const send = async (event: InboxMessageEvent | InboxUpdateEvent): Promise<void> => {
    try {
      await publish(REALTIME_CHANNEL, JSON.stringify(event));
    } catch {
      // Fire-and-forget: realtime is a hint channel, never a dependency.
    }
  };
  return {
    async publishInboxMessage(event) {
      await send({ type: "inbox.message", ...event });
    },
    async publishInboxUpdate(event) {
      await send({ type: "inbox.update", ...event });
    },
  };
}

/** No-op publisher for tests / deployments without a realtime service. */
export const noopRealtimePublisher: RealtimePublisher = {
  async publishInboxMessage() {},
  async publishInboxUpdate() {},
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
