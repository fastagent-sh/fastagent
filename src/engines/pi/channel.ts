/**
 * Channel discovery (the N axis, filesystem form). A channel file default-exports either the existing
 * route factory `(ctx) => Routes`, or an explicit long-connection module `{ name, connect(ctx, signal) }`.
 */
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ChannelContext,
  ChannelModule,
  LongConnection,
  LongConnectionChannelModule,
  Routes,
} from "../../channel.ts";
import { assertRoutePath, parseRouteKey, routeKeysOverlap } from "../../channels/serve.ts";
import { type ModuleLoadFailure, isModuleFile, loadModuleDir } from "../../loader.ts";
import { assertInsideAgentDir } from "../../paths.ts";

/** A dropped route: two channels claim the same key. Surfaced, never silent. */
export interface ChannelCollision {
  route: string;
  source: string;
}

/** A long-connection module bound to the same context route factories receive. Internal serving shape. */
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

/**
 * Import channel files without mounting route factories or opening connections. Deployment needs only
 * the authored structural fact: function exports are route channels; `{ connect() }` exports are
 * long-connection channels. There is no second ingress/lifecycle declaration to keep in sync.
 */
export async function inspectChannels(dir: string): Promise<{
  channels: string[];
  routeChannels: string[];
  longConnectionChannels: string[];
  failures: ModuleLoadFailure[];
}> {
  await assertInsideAgentDir(dir, "channels");
  const { modules, failures } = await loadModuleDir(join(dir, "channels"));
  const channels: string[] = [];
  const routeChannels: string[] = [];
  const longConnectionChannels: string[] = [];
  for (const { name, label, file, mod } of modules) {
    try {
      if (typeof mod.default === "function") {
        channels.push(name);
        routeChannels.push(name);
        continue;
      }
      if (longConnectionModule(mod.default)) {
        validateLongConnectionModule(mod.default, label);
        channels.push(name);
        longConnectionChannels.push(name);
        continue;
      }
      throw new Error(`${label} must default-export (ctx) => Routes or { name, connect(ctx, signal) }`);
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { channels, routeChannels, longConnectionChannels, failures };
}

/**
 * Channel file basenames under `<dir>/channels/` — the authoring view (`fastagent info`), which lists
 * WITHOUT importing. A symlinked channels directory must remain inside the agent dir.
 */
export async function discoverChannelFiles(dir: string): Promise<string[]> {
  await assertInsideAgentDir(dir, "channels");
  let names: string[];
  try {
    names = await readdir(join(dir, "channels"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(isModuleFile)
    .map((name) => name.replace(/\.(ts|js|mjs)$/, ""))
    .sort();
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
    assertRoutePath(
      parseRouteKey(route).path,
      (problem) => `${label}: route "${route}" is not a valid route key — ${problem}`,
    );
  }
  return routes;
}

/** Discover, validate, and bind all channel modules. No long connection is opened here; the CLI owns it. */
export async function loadChannels(
  dir: string,
  ctx: ChannelContext,
): Promise<{
  routes: Routes;
  longConnections: LoadedLongConnectionChannel[];
  routeChannels: string[];
  longConnectionChannels: string[];
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
  const longConnectionChannels: string[] = [];
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
        longConnectionChannels.push(name);
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
        const clash = Object.keys(routes).some((key) => routeKeysOverlap(key, route));
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
  return { routes, longConnections, routeChannels, longConnectionChannels, collisions, failures };
}
