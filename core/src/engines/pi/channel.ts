/**
 * Channel discovery (the N axis, filesystem form): a workspace declares its inbound surface by
 * dropping files in `channels/`, mirroring `tools/`. Each file wires a third-party adapter to the
 * app's `on()` glue and returns the routes it mounts. There is no config-level channel list — a
 * channel always needs glue, so it is always a file.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../../agent.ts";
import { parseRouteKey, type Routes } from "../../host/node.ts";
import { assertInsideWorkspace } from "./definition.ts";
import { isModuleFile, loadModuleDir } from "./loader.ts";

/** A `channels/<name>.ts` default export: receives the assembled agent, returns the routes it mounts. */
export type ChannelModule = (agent: Agent) => Routes;

/** A dropped route: two channels claim the same key. Surfaced, never silent. */
export interface ChannelCollision {
  route: string;
  source: string;
}

/**
 * Channel file basenames under `<dir>/channels/` — the authoring view (`fastagent info`), which lists
 * WITHOUT importing, unlike {@link loadChannels}. It enforces the SAME containment guard so info reports
 * exactly the surface dev/start would accept: a channels/ symlink escaping the workspace is rejected
 * here too. This path is independent of loadChannels', so it must guard the boundary on its own.
 */
export async function discoverChannelFiles(dir: string): Promise<string[]> {
  await assertInsideWorkspace(dir, "channels");
  let names: string[];
  try {
    names = await readdir(join(dir, "channels"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(isModuleFile)
    .map((n) => n.replace(/\.(ts|js|mjs)$/, ""))
    .sort();
}

/**
 * Discover channels in `<dir>/channels/`: each `*.ts|.js|.mjs` default-exports a `(agent) => Routes`
 * factory, called here with the assembled agent; the returned route maps are merged (first file
 * wins a route-key clash, the dropped route surfaced). A file that does not contribute a valid,
 * non-empty Routes object fails visibly.
 */
export async function loadChannels(
  dir: string,
  agent: Agent,
): Promise<{ routes: Routes; collisions: ChannelCollision[] }> {
  // A symlinked channels/ is followed only if it stays inside the workspace, so a deploy that copies
  // the dir includes it (the directory is the agent).
  await assertInsideWorkspace(dir, "channels");
  const modules = await loadModuleDir(join(dir, "channels"));
  const routes: Routes = {};
  const collisions: ChannelCollision[] = [];
  for (const { label, mod } of modules) {
    const factory = mod.default;
    if (typeof factory !== "function") {
      throw new Error(`${label} must default-export (agent) => Routes`);
    }
    let declared: Routes;
    try {
      declared = (factory as ChannelModule)(agent);
    } catch (error) {
      throw new Error(`${label}: ${(error as Error).message}`);
    }
    // A Promise needs its own branch before the object check: mark it handled (a rejected async setup
    // must not go unhandled) and reject it with a precise message rather than the zero-routes one.
    if (
      declared !== null &&
      typeof declared === "object" &&
      typeof (declared as { then?: unknown }).then === "function"
    ) {
      (declared as unknown as Promise<unknown>).catch(() => {});
      throw new Error(`${label} must return Routes synchronously, not a Promise (an async factory is not supported)`);
    }
    if (declared === null || typeof declared !== "object") {
      throw new Error(`${label} must return a Routes object, got ${declared === null ? "null" : typeof declared}`);
    }
    const declaredRoutes = Object.entries(declared);
    if (declaredRoutes.length === 0) {
      throw new Error(
        `${label} declared no routes — return a non-empty { "METHOD /path": handler } object (a Promise, Map, array, or {} yields none)`,
      );
    }
    for (const [route, handler] of declaredRoutes) {
      if (typeof handler !== "function") {
        throw new Error(`${label}: route "${route}" must map to a handler function, got ${typeof handler}`);
      }
      const parsed = parseRouteKey(route);
      if (!parsed.path.startsWith("/")) {
        throw new Error(`${label}: route "${route}" is not a valid route key (expected "METHOD /path" or "/path")`);
      }
      // Overlap, not literal-key, equality: the router treats a bare `/path` as any-method, so
      // `/webhook` and `POST /webhook` clash. `GET /x` vs `POST /x` is fine.
      const clash = Object.keys(routes).some((k) => {
        const e = parseRouteKey(k);
        return (
          e.path === parsed.path &&
          (e.method === undefined || parsed.method === undefined || e.method === parsed.method)
        );
      });
      if (clash) {
        collisions.push({ route, source: label });
        continue;
      }
      routes[route] = handler;
    }
  }
  return { routes, collisions };
}
