import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openShellChannel, presignShellUrl, shellExit } from "../src/deploy/agentcore/shell.ts";

/**
 * The service side of `InvokeAgentRuntimeCommandShell`, as far as a test needs it: an RFC 6455 handshake, masked
 * client frames in, unmasked binary frames out. `onFrame` sees each client frame as [channel, payload].
 */
function shellService(
  onFrame: (channel: number, payload: Buffer, send: (frame: Buffer) => void, close: () => void) => void,
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
        if (opcode === 0x2) onFrame(payload[0] as number, Buffer.from(payload.subarray(1)), send, close);
      }
    });
  });
  return server;
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/shell`;
}

const frame = (channel: number, text = "") => Buffer.concat([Buffer.from([channel]), Buffer.from(text)]);
const read = async (stream: NodeJS.ReadableStream) => {
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text;
};

describe("the AgentCore shell channel", () => {
  it("hands the command to the terminal raw and unechoed, then relays stdout, stdin and the exit status", async () => {
    const seen: string[] = [];
    const url = await listen(
      shellService((channel, payload, send, close) => {
        seen.push(`${channel}:${payload}`);
        if (seen.length === 1) {
          send(
            frame(
              3,
              JSON.stringify({ kind: "Status", metadata: { shellId: "s", reconnected: false }, status: "Success" }),
            ),
          );
          send(frame(1, '{"type":"note","message":"hi"}\n'));
        } else {
          send(frame(3, JSON.stringify({ kind: "Status", metadata: {}, status: "Success" })));
          close();
        }
      }),
    );
    const channel = openShellChannel(url, "echo box");
    const output = read(channel.output);
    channel.input.write('{"id":1,"value":"x"}\n');
    expect(await output).toBe('{"type":"note","message":"hi"}\n');
    expect(await channel.closed).toEqual({ opened: true, how: "exit 0" });
    expect(seen).toEqual([`0:stty raw -echo 2>/dev/null; exec sh -c 'echo box'\n`, `0:{"id":1,"value":"x"}\n`]);
  });

  it("a refused upgrade is a shell that never opened, and says what the caller needs", async () => {
    const url = await listen(shellService(() => {}));
    const channel = openShellChannel(`${url}?refuse`, "true");
    const closed = await channel.closed;
    expect(closed.opened).toBe(false);
    if (!closed.opened) expect(closed.error).toMatch(/InvokeAgentRuntimeCommandShell/);
  });

  it("reads a non-zero exit out of the status frame", () => {
    expect(
      shellExit(
        JSON.stringify({
          status: "Failure",
          reason: "NonZeroExitCode",
          details: { causes: [{ reason: "ExitCode", message: "3" }] },
        }),
      ),
    ).toBe("exit 3");
    expect(shellExit(JSON.stringify({ metadata: { shellId: "s" }, status: "Success" }))).toBeUndefined();
  });

  it("presigns the shell URL of the runtime's own region, with the session and shell in the signed query", async () => {
    const arn = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/fa_x-AbC";
    const url = new URL(
      await presignShellUrl({
        runtimeArn: arn,
        sessionId: "fastagent-ingress-x000000000000000",
        shellId: "sh1",
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" },
        now: new Date("2026-09-30T00:00:00Z"),
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("bedrock-agentcore.ap-southeast-1.amazonaws.com");
    expect(url.pathname).toBe(`/runtimes/${encodeURIComponent(arn)}/ws/shells`);
    expect(url.searchParams.get("shellId")).toBe("sh1");
    expect(url.searchParams.get("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id")).toBe(
      "fastagent-ingress-x000000000000000",
    );
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIDEXAMPLE/20260930/ap-southeast-1/bedrock-agentcore/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("tok");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});
