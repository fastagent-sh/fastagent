/**
 * The WebSocket undici gives Node, and its pings, for the place that holds a WebSocket open against a service that
 * drops one nobody pings: Slack's Socket Mode. undici sends a ping with `undici.ping` and reports the pong on a
 * diagnostics channel.
 */
import { channel } from "node:diagnostics_channel";
import * as undici from "undici";

export const RuntimeWebSocket = undici.WebSocket;
export type RuntimeWebSocket = InstanceType<typeof RuntimeWebSocket>;

/** Send a ping on `socket`. */
export function pinger(socket: RuntimeWebSocket): () => void {
  return () => undici.ping(socket);
}

/** Call `onPong` for each pong `socket` receives. Returns what stops it. */
export function watchPongs(socket: RuntimeWebSocket, onPong: () => void): () => void {
  const pongs = channel("undici:websocket:pong");
  const listener = (message: unknown): void => {
    if ((message as { websocket?: unknown }).websocket === socket) onPong();
  };
  pongs.subscribe(listener);
  return () => pongs.unsubscribe(listener);
}
