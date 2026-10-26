import { describe, expect, test } from "bun:test";
import { createPresenceReader, offlinePresenceReader } from "./presence";

/**
 * Presence reader (#9): the API-side half of the contract. The reader
 * must NEVER throw into the members list - any Redis failure reads as
 * "everyone offline".
 */

describe("createPresenceReader", () => {
  test("returns exactly the ids whose keys exist", async () => {
    const reader = createPresenceReader(async (keys) =>
      keys.map((k) => k.endsWith(":u-online")),
    );
    const online = await reader.onlineUserIds("ws-1", ["u-offline", "u-online"]);
    expect([...online]).toEqual(["u-online"]);
  });

  test("a probe failure reads as an empty set, not an error", async () => {
    const reader = createPresenceReader(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await reader.onlineUserIds("ws-1", ["u-1"])).size).toBe(0);
  });

  test("an empty user list short-circuits without probing", async () => {
    let probed = false;
    const reader = createPresenceReader(async (keys) => {
      probed = true;
      return keys.map(() => true);
    });
    expect((await reader.onlineUserIds("ws-1", [])).size).toBe(0);
    expect(probed).toBe(false);
  });

  test("offlinePresenceReader always reports nobody", async () => {
    expect((await offlinePresenceReader.onlineUserIds("ws-1", ["u-1"])).size).toBe(0);
  });
});
