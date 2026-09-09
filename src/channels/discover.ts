/** Channel discovery (the N axis, filesystem form). */
import { isAbsolute, join } from "node:path";
import type { ChannelContext, ChannelModule, LongConnection, LongConnectionChannelModule, Routes } from "../channel.ts";
import { assertRouteKey, routeKeysConflict } from "./serve.ts";
import { type ModuleLoadFailure, loadModuleDir, moduleInventory } from "../loader.ts";
import { assertInsideAgentDir } from "../paths.ts";

/** A dropped route: two channels claim the same key. */
export interface ChannelCollision {
  route: string;
  source: string;
}

/** A long-connection module bound to the same context route factories receive. */
export interface LoadedLongConnectionChannel {
  name: string;
  connect(signal: AbortSignal): LongConnection;
}

function longConnectionModule(value: unknown): value is LongConnectionChannelModule {
  return value !== null && typeof value === "object" && typeof (value as { connect?: unknown }).connect === "function";
}

function validateLongConnectionModule(value: LongConnectionChannelModule, label: string): void {
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error(`${label}: long-connection channel name must be a non-empty string`);
  }
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

/** Import channel files without mounting route factories or opening connections. */
export async function inspectChannels(dir: string): Promise<{
  channels: DeclaredChannel[];
  failures: ModuleLoadFailure[];
}> {
  await assertInsideAgentDir(dir, "channels");
  const { modules, failures } = await loadModuleDir(join(dir, "channels"));
  const channels: DeclaredChannel[] = [];
  for (const { name, label, file, mod } of modules) {
    try {
      if (typeof mod.default === "function") {
        channels.push({ name, ingress: "webhook" });
        continue;
      }
      if (longConnectionModule(mod.default)) {
        validateLongConnectionModule(mod.default, label);
        channels.push({ name, ingress: "long-connection" });
        continue;
      }
      throw new Error(`${label} must default-export (ctx) => Routes or { name, connect(ctx, signal) }`);
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { channels, failures };
}

/**
 * Channel file basenames under `<dir>/channels/` — the authoring view (`fastagent info`), which lists WITHOUT
 * importing.
 */
export async function discoverChannelFiles(dir: string): Promise<string[]> {
  await assertInsideAgentDir(dir, "channels");
  const entries = await moduleInventory(join(dir, "channels"));
  return entries.map((entry) => entry.name);
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

export async function loadChannels(
  dir: string,
  ctx: ChannelContext,
): Promise<{
  routes: Routes;
  longConnections: LoadedLongConnectionChannel[];
  routeChannels: string[];
  collisions: ChannelCollision[];
  failures: ModuleLoadFailure[];
}> {
  if (!isAbsolute(ctx.stateRoot)) {
    throw new Error(`ChannelContext.stateRoot must be absolute, got "${ctx.stateRoot}"`);
  }
  await assertInsideAgentDir(dir, "channels");
  const { modules, failures } = await loadModuleDir(join(dir, "channels"));
  const routes: Routes = {};
  const longConnections: LoadedLongConnectionChannel[] = [];
  const routeChannels: string[] = [];
  const collisions: ChannelCollision[] = [];

  for (const { name, label, file, mod } of modules) {
    try {
      if (longConnectionModule(mod.default)) {
        validateLongConnectionModule(mod.default, label);
        const channel = mod.default;
        longConnections.push({
          name: channel.name,
          connect: (signal) => channel.connect(ctx, signal),
        });
        continue;
      }
      if (typeof mod.default !== "function") {
        throw new Error(`${label} must default-export (ctx) => Routes or { name, connect(ctx, signal) }`);
      }
      const declared = (mod.default as ChannelModule)(ctx) as unknown;
      if (
        declared !== null &&
        typeof declared === "object" &&
        typeof (declared as { then?: unknown }).then === "function"
      ) {
        (declared as Promise<unknown>).catch(() => {});
        throw new Error(`${label} must return Routes synchronously, not a Promise`);
      }
      const declaredRoutes = validateRoutes(declared, label);
      for (const [route, handler] of declaredRoutes) {
        const clash = Object.keys(routes).some((key) => routeKeysConflict(key, route));
        if (clash) {
          collisions.push({ route, source: label });
          continue;
        }
        routes[route] = handler;
      }
      routeChannels.push(name);
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { routes, longConnections, routeChannels, collisions, failures };
}
