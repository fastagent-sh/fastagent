/**
 * The Channel contract — the trigger side of the product boundary (design/core.md §1: "Trigger:
 * HTTP, channel, schedule → calls an `Agent`"), beside `agent.ts` (what an engine implements) and
 * `session.ts` (the serving control plane). Pure types with no runtime dependency; importing a
 * host, a framework, or an engine here is forbidden, exactly like in those two.
 *
 * §7 fixes two module forms and nothing else — a function is a route channel, an object with
 * `connect` is a long connection. That is a PRODUCT concept, not an implementation detail: an agent
 * directory ships hand-written `channels/*.ts` against it. Which is also why these types live away
 * from the code that serves them: a Feishu WebSocket ingress needs `LongConnection` and has no HTTP
 * in it at all, and a channel author reaching for `ChannelModule` should not pull `node:http` and an
 * HTTP framework in behind it.
 *
 * How a route table becomes a running server is a separate question with a separate answer —
 * `channels/serve.ts`.
 */
import type { Agent } from "./agent.ts";
import type { SessionControl } from "./session.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health).
 *
 *  Fetch-shaped by contract (SPEC §11 names `(Request) => Response` as the gateway form): it is the
 *  one signature every runtime and every embedding app already speaks, so a channel written against
 *  it mounts anywhere without adopting our framework choices. */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/**
 * This deployment's HTTP surface: route key → handler.
 *
 * A key is `"/path"` (any method) or `"METHOD /path"`. The path is a literal, or a `/*` PREFIX
 * mount owning everything beneath it. That language is deliberately small — `assertRoutePath` and
 * `routePathsOverlap` in `channels/serve.ts` enforce it — because two channels must never silently
 * shadow each other, and answering "do these overlap?" for richer patterns is not decidable.
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
