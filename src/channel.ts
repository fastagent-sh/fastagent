/**
 * The Channel contract: how a channel is mounted beside the Agent it talks to (agent-api.ts, agent-api.md §8.1), and
 * `defineChannel`, which types a channel file's export. Importing a host, a framework, or a harness here is forbidden.
 */
import type { Agent, CreateSessionOptions } from "./agent-api.ts";

/** A mounted request handler (a channel's fetch, or a plain route like health). */
export type ChannelHandler = (req: Request) => Response | Promise<Response>;

/** This deployment's HTTP surface: route key → handler. */
export type Routes = Record<string, ChannelHandler>;

/** The session a new conversation forks from, as `sessions.create` takes it; `undefined` starts it empty. */
export type ForkSource = CreateSessionOptions["forkFrom"];

/** What a channel is handed when it is mounted, and all it is handed. */
export interface ChannelContext {
  /** The Agent, in process. */
  agent: Agent;
  /**
   * The session the conversation `key` talks in: the one this channel recorded for it, or a new one created and
   * recorded before it is returned, so a message is sent only into a recorded session. With `forkFrom`, a new one is
   * a fork of what it answers, asked only when `key` has no session yet. Calls for one key are taken one at a time,
   * so two first messages of a new conversation get one session.
   */
  sessionFor(key: string, options?: { forkFrom?: () => Promise<ForkSource> }): Promise<string>;
  /** The session recorded for `key`, without creating one: what a stop command asks of a place nothing was said in. */
  recordedSession(key: string): string | undefined;
  /**
   * Run `work` after the route has answered, one at a time per `place` (a chat, a thread) in the order they arrived,
   * counted as work in flight, which `dev`'s restart and AgentCore's `/ping` wait for. It keeps no record: a turn the
   * process stops before it runs is lost unless the platform delivers its event again. A failure goes to the log.
   */
  turn(place: string, work: () => Promise<void>): void;
  /** The channel's own directory, `<state root>/channels/<the channel file's name>`, for the records it must keep. */
  stateDir: string;
}

/** A `channels/<name>.ts` route channel: receives its context and returns its HTTP routes. */
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

/** What a channel file default-exports, typed: its routes for a context, or a long connection. */
export function defineChannel<T extends ChannelModule | LongConnectionChannelModule>(channel: T): T {
  return channel;
}
