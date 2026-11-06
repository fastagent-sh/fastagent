import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSlackSocket } from "../src/channels/slack/socket.ts";

/**
 * The runtime's own WebSocket against a Slack stand-in speaking the real protocol: the handshake, text frames, pings.
 * What the fakes in slack-socket.test.ts cannot say is whether undici's socket delivers a message, a pong and a close
 * the way this module reads them.
 */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length =
    payload.length < 126
      ? Buffer.from([payload.length])
      : Buffer.from([126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([Buffer.from([0x80 | opcode]), length, payload]);
}

/** The client's frames are masked; read what a buffer holds, whole frames only. */
function* clientFrames(buffer: Buffer): Generator<{ opcode: number; payload: Buffer }> {
  let at = 0;
  while (at + 2 <= buffer.length) {
    const opcode = (buffer[at] as number) & 0x0f;
    let length = (buffer[at + 1] as number) & 0x7f;
    let header = 2;
    if (length === 126) {
      length = buffer.readUInt16BE(at + 2);
      header = 4;
    }
    const mask = buffer.subarray(at + header, at + header + 4);
    const body = buffer.subarray(at + header + 4, at + header + 4 + length);
    if (body.length < length) return;
    yield { opcode, payload: Buffer.from(body.map((byte, i) => byte ^ (mask[i % 4] as number))) };
    at += header + 4 + length;
  }
}

interface Peer {
  socket: Socket;
  say(message: unknown): void;
  texts: string[];
  pings: number;
  /** The client sent a close frame. */
  closed: boolean;
}

async function slackStandIn(options: { answerPings: boolean }) {
  const peers: Peer[] = [];
  const server: Server = createServer((request, response) => {
    if (request.url?.endsWith("/apps.connections.open")) {
      const { port } = server.address() as { port: number };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/link` }));
    } else {
      response.writeHead(404).end();
    }
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    const accept = createHash("sha1")
      .update(String(request.headers["sec-websocket-key"]) + GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const peer: Peer = {
      socket,
      texts: [],
      pings: 0,
      closed: false,
      say: (message) => socket.write(frame(1, Buffer.from(JSON.stringify(message)))),
    };
    socket.on("data", (chunk: Buffer) => {
      for (const { opcode, payload } of clientFrames(chunk)) {
        if (opcode === 1) peer.texts.push(payload.toString());
        if (opcode === 8) peer.closed = true;
        if (opcode === 9) {
          peer.pings++;
          if (options.answerPings) socket.write(frame(10, payload));
        }
      }
    });
    socket.on("error", () => {});
    peers.push(peer);
    peer.say({ type: "hello" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { peers, apiBaseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

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
