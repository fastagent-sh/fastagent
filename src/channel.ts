/**
 * The Channel contract: how a channel is mounted beside the Agent it talks to (agent-api.ts). Pure types: importing a
 * host, a framework, or a harness here is forbidden.
 */
import type { Agent } from "./agent-api.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health). */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/** This deployment's HTTP surface: route key → handler. */
export type Routes = Record<string, ChannelHandler>;

/**
 * What the framework hands a channel at mount time: the Agent, in process, and the resolved state ROOT (absolute;
 * `FASTAGENT_STATE_DIR` > `<root>/.state`), where the channel keeps which session each of its places talks in.
 */
export interface ChannelContext {
  agent: Agent;
  stateRoot: string;
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
