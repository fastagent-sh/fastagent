import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSlackSocket } from "../src/channels/slack/socket.ts";
import { type Peer, frame, slackStandIn } from "./slack-stand-in.ts";

/**
 * The runtime's own WebSocket against a Slack stand-in speaking the real protocol: the handshake, text frames, pings.
 * What the fakes in slack-socket.test.ts cannot say is whether undici's socket delivers a message, a pong and a close
 * the way this module reads them.
 */
const aborts: AbortController[] = [];
const servers: { close(): void }[] = [];
afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  for (const server of servers.splice(0)) server.close();
});

async function connected(
  options: { answerPings: boolean },
  timing: Parameters<typeof connectSlackSocket>[0]["timing"],
) {
  const stand = await slackStandIn(options);
  servers.push(stand);
  const abort = new AbortController();
  aborts.push(abort);
  const ingested: unknown[] = [];
  const connection = connectSlackSocket(
    {
      apiBaseUrl: stand.apiBaseUrl,
      appToken: "xapp-1-A1-1-abc",
      ingest: async (envelope) => {
        ingested.push(envelope);
      },
      timing,
    },
    abort.signal,
  );
  connection.ready.catch(() => {});
  connection.closed.catch(() => {});
  return { ...stand, connection, ingested };
}

describe("slack socket mode over a real WebSocket", () => {
  it("is ready at hello, takes an event, and acknowledges it on the wire", async () => {
    const { peers, connection, ingested } = await connected(
      { answerPings: true },
      { pingEveryMs: 1_000_000, pongWithinMs: 1_000_000 },
    );
    await connection.ready;
    const [peer] = peers as [Peer];
    peer.say({
      envelope_id: "E1",
      type: "events_api",
      payload: { type: "event_callback", event: { type: "message", text: "hi" } },
    });
    await vi.waitFor(() => expect(peer.texts).toEqual(['{"envelope_id":"E1"}']));
    expect(ingested).toEqual([{ type: "event_callback", event: { type: "message", text: "hi" } }]);
  });

  it("keeps a connection whose pings are answered", async () => {
    const { peers, connection } = await connected({ answerPings: true }, { pingEveryMs: 20, pongWithinMs: 150 });
    await connection.ready;
    // Past several windows for a pong: one that went unnoticed would have dropped the connection by now.
    await vi.waitFor(() => expect(peers[0]?.pings).toBeGreaterThanOrEqual(12));
    expect(peers).toHaveLength(1);
  });

  it("drops a connection whose pings are not answered, and connects again", async () => {
    const { peers, connection } = await connected(
      { answerPings: false },
      { pingEveryMs: 20, pongWithinMs: 80, retryFirstMs: 5 },
    );
    await connection.ready;
    await vi.waitFor(() => expect(peers.length).toBeGreaterThanOrEqual(2));
    expect(peers[0]?.closed).toBe(true);
  });

  it("connects again when Slack closes the socket", async () => {
    const { peers, connection } = await connected(
      { answerPings: true },
      { pingEveryMs: 1_000_000, pongWithinMs: 1_000_000, retryFirstMs: 5 },
    );
    await connection.ready;
    (peers[0] as Peer).socket.end(frame(8, Buffer.from([0x03, 0xe8])));
    await vi.waitFor(() => expect(peers).toHaveLength(2));
  });
});
