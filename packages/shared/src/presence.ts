/**
 * Member presence contract (adoption package #9) - the ONE definition
 * shared by the realtime service (writer), the API (reader) and the web
 * client (heartbeat source), so the three can never drift apart.
 *
 * Semantics, kept deliberately honest: presence means "this user has an
 * authenticated realtime socket that checked in recently" - it is NOT
 * proof the person is looking at the screen. The realtime hub writes
 * one Redis key per (workspace, user) when a socket authenticates and
 * refreshes it on every client ping; the key carries a TTL, so a
 * crashed tab or a dead realtime process ages out on its own.
 *
 * Numbers: the client pings every {@link PRESENCE_HEARTBEAT_MS}; the
 * server TTL is a little over two heartbeats, so one missed ping (tab
 * throttling, brief network stall) does not flicker a member offline,
 * while a genuinely gone member disappears within ~75s.
 */

export const PRESENCE_KEY_PREFIX = "presence:";

/** Redis key for one (workspace, user) presence record. */
export function presenceKey(workspaceId: string, userId: string): string {
  return `${PRESENCE_KEY_PREFIX}${workspaceId}:${userId}`;
}

/** How often the web client pings its realtime socket (ms). */
export const PRESENCE_HEARTBEAT_MS = 30_000;

/** Server-side key TTL (seconds): ~2.5 heartbeats of slack. */
export const PRESENCE_TTL_SECONDS = 75;
