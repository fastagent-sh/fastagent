/**
 * A definition's channels, mounted: each route channel's routes, and each long connection bound to its context. The
 * channels are what the definition built (`BuiltDefinition.channels`), by the name `fastagent.config.ts` gives them; a
 * channel's shape is checked there, by {@link channelProblem}, and its routes here, where they are first asked for.
 */
import type { Agent } from "@fastagent-sh/client/agent-api";
import type { Channel, LongConnection, Routes } from "@fastagent-sh/client/channel";
import { channelContext } from "./context.ts";
import { assertRouteKey, routeKeysConflict } from "./router.ts";

/** A long connection bound to the context its channel is mounted with. */
export interface LoadedLongConnectionChannel {
  name: string;
  connect(signal: AbortSignal): LongConnection;
}

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function toolProblem(value: unknown, i: number): string | undefined {
  const tool = value as Partial<Record<"name" | "description" | "parameters" | "execute", unknown>> | null;
  if (typeof tool?.name !== "string" || !TOOL_NAME.test(tool.name)) {
    return `tools[${i}].name must be lowercase letters, digits and _, starting with a letter`;
  }
  if (typeof tool.description !== "string" || tool.description.trim() === "") {
    return `tool "${tool.name}" needs a description`;
  }
  if (typeof tool.parameters !== "object" || tool.parameters === null) {
    return `tool "${tool.name}" needs parameters, a JSON Schema object`;
  }
  return typeof tool.execute === "function" ? undefined : `tool "${tool.name}" needs an execute function`;
}

/** Why `value` is not a channel: one of `routes(ctx)` or `connect(ctx, signal)`, and well-formed `tools`. */
export function channelProblem(value: unknown): string | undefined {
  const channel = value as Partial<Record<"routes" | "connect" | "tools", unknown>> | null;
  const routes = typeof channel?.routes === "function";
  const connect = typeof channel?.connect === "function";
  if (routes === connect) {
    return "must be a channel (defineChannel), receiving by routes(ctx) or by connect(ctx, signal), not both";
  }
  const tools = channel?.tools;
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return "tools must be an array";
  return tools.map(toolProblem).find((problem) => problem !== undefined);
}

/** How a channel is reached: at its routes, or over the connection it opens. */
export function channelIngress(channel: Channel): "webhook" | "long-connection" {
  return "routes" in channel ? "webhook" : "long-connection";
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
  channels: ReadonlyMap<string, Channel>,
  agent: Agent,
  stateRoot: string,
): { routes: Routes; longConnections: LoadedLongConnectionChannel[]; routeChannels: string[] } {
  const routes: Routes = {};
  const owners = new Map<string, string>();
  const longConnections: LoadedLongConnectionChannel[] = [];
  const routeChannels: string[] = [];
  for (const [name, channel] of channels) {
    const label = `channel "${name}"`;
    const ctx = channelContext(agent, stateRoot, name);
    if (!("routes" in channel)) {
      longConnections.push({ name, connect: (signal) => channel.connect(ctx, signal) });
      continue;
    }
    const declared = channel.routes(ctx) as unknown;
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
