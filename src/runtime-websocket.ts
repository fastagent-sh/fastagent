/**
 * The runtime's own WebSocket and the pings it can send, for the two places that hold a WebSocket open against a
 * service that drops one nobody pings: Slack's Socket Mode and AgentCore's command shell.
 *
 * Node's undici sends a ping with `undici.ping` and reports the pong on a diagnostics channel; Bun 1.4.4 and later has
 * both in its `undici` shim. Before that the shim has no `ping` and its WebSocket is the runtime's own, which pings with
 * its `ping()` and reports a `pong` event. A runtime with neither has no pings: `pinger` says so, and the caller decides.
 *
 * A namespace import, because Bun's `undici` is a shim that leaves out what it does not have, and a named import of a
 * missing export fails the whole module's link.
 */
import { channel } from "node:diagnostics_channel";
import * as undici from "undici";

export const RuntimeWebSocket = undici.WebSocket ?? globalThis.WebSocket;
export type RuntimeWebSocket = InstanceType<typeof RuntimeWebSocket>;

const undiciPings = undici.WebSocket !== undefined && typeof undici.ping === "function";
const nativePing = (socket: RuntimeWebSocket) => (socket as { ping?: () => void }).ping;

/** Send a ping on `socket`, or `undefined` when this runtime cannot. */
export function pinger(socket: RuntimeWebSocket): (() => void) | undefined {
  if (undiciPings) return () => undici.ping(socket as never);
  return typeof nativePing(socket) === "function" ? () => nativePing(socket)?.call(socket) : undefined;
}

/** Call `onPong` for each pong `socket` receives. Returns what stops it. */
export function watchPongs(socket: RuntimeWebSocket, onPong: () => void): () => void {
  if (undiciPings) {
    const pongs = channel("undici:websocket:pong");
    const listener = (message: unknown): void => {
      if ((message as { websocket?: unknown }).websocket === socket) onPong();
    };
    pongs.subscribe(listener);
    return () => pongs.unsubscribe(listener);
  }
  if (typeof nativePing(socket) !== "function") return () => {};
  const listener = (): void => onPong();
  socket.addEventListener("pong", listener);
  return () => socket.removeEventListener("pong", listener);
}
