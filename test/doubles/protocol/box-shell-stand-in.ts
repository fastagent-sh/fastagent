import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

/**
 * The service side of `InvokeAgentRuntimeCommandShell`, as far as a test needs it: an RFC 6455 handshake, masked
 * client frames in, unmasked binary frames out. `onFrame` sees each binary client frame as [channel, payload]; `onOpcode`
 * sees every frame's WebSocket opcode, a ping included. One double for the shell's WebSocket, driven on Bun by
 * test/bun/agentcore-shell.ts.
 */
export function shellService(
  onFrame: (channel: number, payload: Buffer, send: (frame: Buffer) => void, close: () => void) => void,
  onOpcode: (opcode: number) => void = () => {},
) {
  const server = createServer((_req, res) => res.writeHead(403).end("AccessDeniedException"));
  server.on("upgrade", (req, socket: Duplex) => {
    if (req.url?.includes("refuse")) {
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const out = (opcode: number, payload: Buffer) => {
      const head =
        payload.length < 126
          ? Buffer.from([0x80 | opcode, payload.length])
          : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([head, payload]));
    };
    const send = (frame: Buffer) => out(0x2, frame);
    const close = () => {
      out(0x8, Buffer.from([0x03, 0xe8])); // 1000
      socket.end();
    };
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = (buffered[0] as number) & 0x0f;
        let len = (buffered[1] as number) & 0x7f;
        let at = 2;
        if (len === 126) {
          len = buffered.readUInt16BE(2);
          at = 4;
        }
        if (buffered.length < at + 4 + len) return;
        const mask = buffered.subarray(at, at + 4);
        const payload = Buffer.from(buffered.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ (mask[i % 4] as number));
        buffered = buffered.subarray(at + 4 + len);
        onOpcode(opcode);
        if (opcode === 0x2) onFrame(payload[0] as number, Buffer.from(payload.subarray(1)), send, close);
      }
    });
  });
  return server;
}
