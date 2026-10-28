/**
 * A definition's channels, mounted: each route channel's routes, and each long connection bound to its context. The
 * modules are what the definition built (`BuiltDefinition.channels`); a channel's shape is checked there, by
 * {@link channelModuleProblem}, and its routes here, where it is first called.
 */
import type { Agent } from "../agent-api.ts";
import type { ChannelModule, LongConnection, LongConnectionChannelModule, Routes } from "../channel.ts";
import { channelContext } from "./context.ts";
import { assertRouteKey, routeKeysConflict } from "./router.ts";

export type AnyChannelModule = ChannelModule | LongConnectionChannelModule;

/** A long-connection module bound to the same context route factories receive. */
export interface LoadedLongConnectionChannel {
  name: string;
  connect(signal: AbortSignal): LongConnection;
}

function longConnectionModule(value: unknown): value is LongConnectionChannelModule {
  return value !== null && typeof value === "object" && typeof (value as { connect?: unknown }).connect === "function";
}

/** Why `value` is not a channel module: a route channel's `(ctx) => Routes`, or a long connection's object. */
export function channelModuleProblem(value: unknown): string | undefined {
  if (typeof value === "function") return undefined;
  if (!longConnectionModule(value)) return "must default-export (ctx) => Routes or { name, connect(ctx, signal) }";
  return typeof value.name === "string" && value.name.trim() !== ""
    ? undefined
    : "long-connection channel name must be a non-empty string";
}

/** HOW A CHANNEL IS REACHED — the authored structural fact, and the ONE shape it travels in. */
export type ChannelIngress = "webhook" | "long-connection";

/** One channel a directory declares, with the ingress its module shape says it has. */
export interface DeclaredChannel {
  name: string;
  ingress: ChannelIngress;
}

/** Declared channels from basenames that share one ingress. */
export function declaredChannels(names: readonly string[], ingress: ChannelIngress = "webhook"): DeclaredChannel[] {
  return names.map((name) => ({ name, ingress }));
}

/** How a channel module is reached: its routes, or the connection it opens. */
export function channelIngress(module: AnyChannelModule): ChannelIngress {
  return typeof module === "function" ? "webhook" : "long-connection";
}

function validateRoutes(value: unknown, label: string): [string, (req: Request) => Response | Promise<Response>][] {
  if (value === null || typeof value !== "object" || value instanceof Map) {
    throw new Error(`${label} must return a Routes object`);
  }
  const routes = Object.entries(value as Routes);
  if (routes.length === 0) {
    throw new Error(`${label} declared no routes — return a non-empty { "METHOD /path": handler } object`);
  }
  for (const [route, handler] of routes) {
    if (typeof handler !== "function") {
      throw new Error(`${label}: route "${route}" must map to a handler function, got ${typeof handler}`);
    }
    assertRouteKey(route, (problem) => `${label}: route "${route}" is not a valid route key — ${problem}`);
  }
  return routes;
}

/**
 * Mount the channels, each with its own context (context.ts): every route of every route channel (two claiming one
 * route is refused), and the connections.
 */
export function mountChannels(
  modules: ReadonlyMap<string, AnyChannelModule>,
  agent: Agent,
  stateRoot: string,
): { routes: Routes; longConnections: LoadedLongConnectionChannel[]; routeChannels: string[] } {
  const routes: Routes = {};
  const owners = new Map<string, string>();
  const longConnections: LoadedLongConnectionChannel[] = [];
  const routeChannels: string[] = [];
  for (const [name, module] of modules) {
    const label = `src/channels/${name}`;
    const ctx = channelContext(agent, stateRoot, name);
    if (typeof module !== "function") {
      longConnections.push({ name: module.name, connect: (signal) => module.connect(ctx, signal) });
      continue;
    }
    const declared = module(ctx) as unknown;
    if (
      declared !== null &&
      typeof declared === "object" &&
      typeof (declared as { then?: unknown }).then === "function"
    ) {
      (declared as Promise<unknown>).catch(() => {});
      throw new Error(`${label} must return Routes synchronously, not a Promise`);
    }
    for (const [route, handler] of validateRoutes(declared, label)) {
      const taken = [...owners.keys()].find((key) => routeKeysConflict(key, route));
      if (taken !== undefined) {
        throw new Error(`${label} serves "${route}", which ${owners.get(taken)} already serves as "${taken}"`);
      }
      owners.set(route, label);
      routes[route] = handler;
    }
    routeChannels.push(name);
  }
  return { routes, longConnections, routeChannels };
}
