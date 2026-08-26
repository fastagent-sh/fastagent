/**
 * The Channel contract — the trigger side of the product boundary (core.md §1), beside `agent.ts`
 * (what an engine implements) and `session.ts` (the serving control plane). Pure types, no runtime
 * dependency; importing a host, a framework, or an engine here is forbidden, as in those two.
 *
 * §7 fixes two module forms: a function is a route channel, an object with `connect` is a long
 * connection. An agent directory ships hand-written `channels/*.ts` against them, which is why they
 * live away from the code that serves them — a WebSocket ingress needs `LongConnection` and has no
 * HTTP in it, and a `ChannelModule` import must not drag `node:http` in behind it.
 *
 * How a route table becomes a running server: `channels/serve.ts`.
 */
import type { Agent } from "./agent.ts";
import type { SessionControl } from "./session.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health). Fetch-shaped by
 *  contract (SPEC §11): the one signature every runtime and embedding app already speaks. */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/**
 * This deployment's HTTP surface: route key → handler.
 *
 * A key is `"/path"` (any method) or `"METHOD /path"`, with a LITERAL path — small on purpose, so
 * that "would these two fight over a request?" is string equality rather than a prediction about a
 * matcher, and no channel silently shadows another. `assertRouteKey` in `channels/serve.ts`
 * enforces it; a handler owning a prefix is a `PrefixMount`, never a key.
 */
export type Routes = Record<string, ChannelHandler>;

/**
 * What the framework hands a channel at mount time: the assembled agent plus the resolved state ROOT
 * (absolute; `FASTAGENT_STATE_DIR` > `<root>/.state`). Channels derive their OWN durable home from
 * it (`<stateRoot>/channels/<kind>/`) — they never anchor on `process.cwd()`. env is the OPERATOR
 * input plane; this context is how the resolved result reaches code (embedders without the agent
 * opener construct it explicitly).
 */
export interface ChannelContext {
  agent: Agent;
  stateRoot: string;
  /** The serving session-control hub, when the serve wires one (`config.sessionControl`). Channels
   *  use it for DISPATCH only (the user-facing stop command); observation stays on the data plane. */
  control?: SessionControl;
}

/** A `channels/<name>.ts` route channel: receives mount context and returns its HTTP routes. */
export type ChannelModule = (ctx: ChannelContext) => Routes;

/** One logical long connection's lifecycle. `ready` settles after its first usable connection — and
 * when `signal` aborts before one exists it must still settle: resolution then means cancellation, not
 * readiness (the server skips ready-side effects once the signal is aborted; it must never hang).
 * `closed` resolves after abort-driven shutdown and rejects on a terminal connection failure. */
export interface LongConnection {
  ready: Promise<void>;
  closed: Promise<void>;
}

/** A long-connection channel is an explicit module object rather than an HTTP-route factory.
 * The adapter owns reconnects and treats `signal` as its sole shutdown command. */
export interface LongConnectionChannelModule {
  name: string;
  connect(ctx: ChannelContext, signal: AbortSignal): LongConnection;
}
