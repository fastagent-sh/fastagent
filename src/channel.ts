/**
 * The Channel contract — the trigger side of the product boundary (core.md §1), beside `agent.ts` (what an engine
 * implements) and `session.ts` (the serving control plane). Pure types: importing a host, a framework, or an engine
 * here is forbidden, as in those two.
 */
import type { Agent } from "./agent.ts";
import type { SessionControl } from "./session.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health). */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/** This deployment's HTTP surface: route key → handler. */
export type Routes = Record<string, ChannelHandler>;

/**
 * What the framework hands a channel at mount time: the assembled agent plus the resolved state ROOT (absolute;
 * `FASTAGENT_STATE_DIR` > `<root>/.state`).
 */
export interface ChannelContext {
  agent: Agent;
  stateRoot: string;
  /** The serving session-control hub, when the serve wires one (`config.sessionControl`). */
  control?: SessionControl;
}

/** A `channels/<name>.ts` route channel: receives mount context and returns its HTTP routes. */
export type ChannelModule = (ctx: ChannelContext) => Routes;

export interface LongConnection {
  ready: Promise<void>;
  closed: Promise<void>;
}

/** A long-connection channel is an explicit module object rather than an HTTP-route factory. */
export interface LongConnectionChannelModule {
  name: string;
  connect(ctx: ChannelContext, signal: AbortSignal): LongConnection;
}
