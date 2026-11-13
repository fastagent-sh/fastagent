import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { Socket } from "node:net";

/**
 * A Slack stand-in speaking the real Socket Mode protocol: `apps.connections.open`, the WebSocket handshake, text frames,
 * pings. One double for the runtime's own WebSocket, driven on Node by slack-socket.test.ts and on Bun by
 * test/smoke/bun/slack-socket.ts.
 */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function frame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
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

export interface Peer {
  socket: Socket;
  say(message: unknown): void;
  texts: string[];
  pings: number;
  /** The client sent a close frame. */
  closed: boolean;
}

export async function slackStandIn(options: { answerPings: boolean }) {
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
