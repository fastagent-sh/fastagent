/** Channel discovery (the N axis, filesystem form). */
import { isAbsolute, join } from "node:path";
import type { ChannelContext, ChannelModule, LongConnection, LongConnectionChannelModule, Routes } from "../channel.ts";
import { assertRouteKey, routeKeysConflict } from "./serve.ts";
import { type ModuleLoadFailure, loadModuleDir } from "../loader.ts";
import { type DeclaredSecret, readSecretDeclaration } from "../declared-secrets.ts";
import { gateSecrets } from "../secrets-gate.ts";
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
  /** What each channel declared through {@link defineChannel}, BY CHANNEL NAME — the only way a
   *  CUSTOM channel's credentials can reach a deploy, since nothing else here can name them. */
  secrets: Map<string, DeclaredSecret[]>;
  failures: ModuleLoadFailure[];
}> {
  await assertInsideAgentDir(dir, "channels");
  const { modules, failures } = await loadModuleDir(join(dir, "channels"));
  const channels: DeclaredChannel[] = [];
  const secrets = new Map<string, DeclaredSecret[]>();
  for (const { name, label, file, mod } of modules) {
    try {
      const declaration = readSecretDeclaration(mod.default, label);
      if (declaration.error !== undefined) throw new Error(declaration.error);
      if (typeof mod.default === "function") {
        channels.push({ name, ingress: "webhook" });
      } else if (longConnectionModule(mod.default)) {
        validateLongConnectionModule(mod.default, label);
        channels.push({ name, ingress: "long-connection" });
      } else {
        throw new Error(`${label} must default-export (ctx) => Routes or { name, connect(ctx, signal) }`);
      }
      secrets.set(name, declaration.secrets);
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { channels, secrets, failures };
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
  // Collected here, GATED at the end of the function: this is a serving path, so an unset declared
  // value must stop it (a channel built from an empty credential is the failure the declaration
  // exists to prevent — a webhook that accepts forged updates, a bot that cannot reply), while
  // `inspectChannels` — the reporting reader — only collects.
  const declaredSecrets = new Map<string, DeclaredSecret[]>();
  const declaring = modules.filter(({ name, label, file, mod }) => {
    const declaration = readSecretDeclaration(mod.default, label);
    if (declaration.error !== undefined) {
      failures.push({ label, file, message: declaration.error });
      return false;
    }
    declaredSecrets.set(name, declaration.secrets);
    return true;
  });

  for (const { name, label, file, mod } of declaring) {
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
  // Gated LAST, after the loop has said what it found (the gate reports those failures before it
  // refuses — src/secrets-gate.ts, decision 2). Binding a module ahead of the gate costs nothing: a
  // route factory builds handlers; nothing listens or dials until the caller mounts what this returns.
  gateSecrets({ declared: declaredSecrets, failures });
  return { routes, longConnections, routeChannels, collisions, failures };
}
