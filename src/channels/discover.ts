/**
 * Channel discovery (the N axis, filesystem form). A channel file default-exports either the existing
 * route factory `(ctx) => Routes`, or an explicit long-connection module `{ name, connect(ctx, signal) }`.
 *
 * Engine-neutral, and living here rather than under `engines/` because of it: reading `channels/*.ts`
 * is the Channel contract plus a directory, with no engine in sight.
 */
import { isAbsolute, join } from "node:path";
import type { ChannelContext, ChannelModule, LongConnection, LongConnectionChannelModule, Routes } from "../channel.ts";
import { assertRouteKey, routeKeysConflict } from "./serve.ts";
import { type ModuleLoadFailure, loadModuleDir, moduleInventory } from "../loader.ts";
import { assertInsideAgentDir } from "../paths.ts";

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
 * HOW A CHANNEL IS REACHED — the authored structural fact, and the ONE shape it travels in.
 *
 * A webhook channel is reached at a URL someone must set; a long-connection channel dials out, so
 * there is no URL and setting one breaks it (Telegram answers `getUpdates` with 409 once a webhook
 * exists). Everything downstream — which secrets to carry, what the runbook says, what `--run` and
 * `--tunnel` register — is a question about THIS.
 *
 * It is one list because it used to be three (`channels` + `routeChannels` + `longConnectionChannels`,
 * two of them including custom channels and one not), and every consumer re-derived the answer from
 * whichever pair it happened to hold. Two deploys shipped a webhook for a long-connection channel
 * that way. A list of pairs cannot be recombined wrongly, and a consumer that needs a subset asks for
 * it here rather than trusting its caller to have filtered.
 */
export type ChannelIngress = "webhook" | "long-connection";

/** One channel a directory declares, with the ingress its module shape says it has. `name` is the
 *  basename, which is a {@link ChannelKind} for the first-party ones and anything for a custom one. */
export interface DeclaredChannel {
  name: string;
  ingress: ChannelIngress;
}

/** Declared channels from basenames that share one ingress: the serving surface's mounted route list
 *  (a long-connection channel mounts no HTTP route, so every route IS a webhook channel), and fixtures. */
export function declaredChannels(names: readonly string[], ingress: ChannelIngress = "webhook"): DeclaredChannel[] {
  return names.map((name) => ({ name, ingress }));
}

/**
 * Import channel files without mounting route factories or opening connections. Deployment needs only
 * the authored structural fact: function exports are webhook channels; `{ connect() }` exports are
 * long-connection channels. There is no second ingress/lifecycle declaration to keep in sync.
 */
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
 * Channel file basenames under `<dir>/channels/` — the authoring view (`fastagent info`), which lists
 * WITHOUT importing. A symlinked channels directory must remain inside the agent dir.
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
  return { routes, longConnections, routeChannels, longConnectionChannels, collisions, failures };
}
