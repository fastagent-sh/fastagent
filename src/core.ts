// Engine-neutral Agent Handler contract, consumption helpers, channel kit, and time triggers.
// ZERO third-party dependencies, enforced by test — the Node HTTP binding lives at `/node`.
// Import this subpath from channel packages or contract-only integrations to avoid loading the pi runtime.
// Session-control layering (design §1): the CONTRACT (SessionControl types, error codes) lives
// behind the `/session` subpath so interactive serving does not grow the minimal handler contract,
// and the pi hub (`createPiSessionControl`) lives under `/pi`. The engine-neutral TRANSPORT —
// `createControlPlane` server-side, `connectSessionControl`/`connectAgent` client-side — belongs here
// with the rest of the channel kit: fetch-shaped routes and contract-consuming clients, no pi
// import anywhere in their closure.
export type { Agent, AgentEvent, ImageRef, Json, Prompt, Scope } from "./agent.ts";
export { collect, AgentFailure, type CollectResult } from "./collect.ts";
export type { ModuleLoadFailure } from "./loader.ts";

export { createInvokeHandler } from "./channels/http.ts";
// The control plane MOUNTS itself: `createAgentService` wires it when the config asks for it. Only
// the wire envelope is public here — a remote consumer needs to read it.
export type { WireEvent } from "./channels/control.ts";
export {
  ControlRequestError,
  connectAgent,
  connectSessionControl,
  type RemoteEndpointOptions,
} from "./session-remote.ts";
export { readBodyCapped } from "./channels/body.ts";
export { text, textHeaders } from "./channels/respond.ts";
export type {
  ChannelContext,
  ChannelHandler,
  ChannelModule,
  LongConnection,
  LongConnectionChannelModule,
  Routes,
} from "./channel.ts";
// Mounting only. Composing a route table (`router`) and owning a prefix (`PrefixMount`) are how
// `createAgentService` assembles a service — not something a caller has to reproduce.
// Binding to a Node server lives at `/node`: it is the only runtime-specific piece here, and the
// only one that costs a third-party package.

// `defineSchedule` is what a `schedules/*.ts` file is written against. Discovering those files and
// running the clock is what `createAgentService` does with them — parts a caller does not reproduce.
export { defineSchedule, type LoadedSchedule, type Schedule } from "./schedule/schedule.ts";
