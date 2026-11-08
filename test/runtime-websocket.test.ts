import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What a runtime's undici offers decides how a socket is pinged (src/runtime-websocket.ts). Node's has `ping` and Bun
 * before 1.4.4 has not, so the branch Bun takes is made here by standing undici in with one that has none. The real
 * sockets and the real pings are in slack-socket-wire.test.ts and agentcore-shell.test.ts (Node) and test/bun/ (Bun).
 */
class SocketWithPing extends EventTarget {
  pings = 0;
  ping(): void {
    this.pings++;
  }
}
class SocketWithoutPing extends EventTarget {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

async function runtimeWithout(ping: "ping" | "none") {
  vi.resetModules();
  const WebSocket = ping === "ping" ? SocketWithPing : SocketWithoutPing;
  vi.doMock("undici", () => ({ WebSocket, ping: undefined }));
  return import("../src/runtime-websocket.ts");
}

afterEach(() => {
  vi.doUnmock("undici");
  vi.resetModules();
});

describe("a runtime whose undici has no ping", () => {
  it("pings with the socket's own ping(), and takes its pong event", async () => {
    const { RuntimeWebSocket, pinger, watchPongs } = await runtimeWithout("ping");
    const socket = new RuntimeWebSocket("ws://unused") as unknown as SocketWithPing;
    const pongs: string[] = [];
    const stop = watchPongs(socket as never, () => pongs.push("pong"));
    pinger(socket as never)?.();
    socket.dispatchEvent(new Event("pong"));
    expect({ pings: socket.pings, pongs }).toEqual({ pings: 1, pongs: ["pong"] });
    stop();
    socket.dispatchEvent(new Event("pong"));
    expect(pongs).toEqual(["pong"]);
  });

  it("has no ping at all when the socket has none either, and listens for no pong", async () => {
    const { RuntimeWebSocket, pinger, watchPongs } = await runtimeWithout("none");
    const socket = new RuntimeWebSocket("ws://unused") as unknown as SocketWithoutPing;
    const pongs: string[] = [];
    expect(pinger(socket as never)).toBeUndefined();
    watchPongs(socket as never, () => pongs.push("pong"))();
    socket.dispatchEvent(new Event("pong"));
    expect(pongs).toEqual([]);
  });

  it("the shell refuses to open on a runtime that cannot ping, and closes the socket it made", async () => {
    const made: SocketWithoutPing[] = [];
    vi.resetModules();
    vi.doMock("undici", () => ({
      WebSocket: class extends SocketWithoutPing {
        constructor() {
          super();
          made.push(this);
        }
      },
      ping: undefined,
    }));
    const { openShellChannel } = await import("../src/deploy/agentcore/shell.ts");
    expect(() => openShellChannel("ws://unused", "true")).toThrow(/cannot send WebSocket pings/);
    expect(made.map((socket) => socket.closed)).toEqual([true]);
  });
});
