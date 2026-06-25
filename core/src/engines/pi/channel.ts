/**
 * Channel discovery (the N axis, filesystem form): a workspace declares its inbound surface by
 * dropping files in `channels/`, mirroring how `tools/` declares capabilities. Each file wires a
 * third-party ADAPTER (e.g. githubChannel — verify + parse + ACK) to the app's mandatory `on()`
 * glue and returns the routes it mounts. There is no config-level channel list: a channel always
 * needs glue, so it is always a file (unlike a glue-free third-party tool, which `config.tools`
 * may list inline).
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent } from "../../agent.ts";
import type { Routes } from "../../host/node.ts";
import { moduleLoadHint } from "./loader.ts";

/** A `channels/<name>.ts` default export: receives the assembled agent, returns the routes it mounts. */
export type ChannelModule = (agent: Agent) => Routes;

/** A dropped route: two channels claim the same key. Surfaced, never silent. */
export interface ChannelCollision {
  route: string;
  source: string;
}

const CHANNEL_EXTS = new Set([".ts", ".js", ".mjs"]);

/**
 * Discover channels in `<dir>/channels/`: each top-level `*.ts|.js|.mjs` default-exports a
 * `(agent) => Routes` factory, called here with the assembled agent; the returned route maps are
 * merged (first file wins a route-key clash, the dropped route surfaced). Missing `channels/` is
 * normal (no routes). A file that does not default-export a function fails visibly.
 */
export async function loadChannels(
  dir: string,
  agent: Agent,
): Promise<{ routes: Routes; collisions: ChannelCollision[] }> {
  const channelsDir = join(dir, "channels");
  let entries: Dirent[];
  try {
    entries = await readdir(channelsDir, { withFileTypes: true });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "not_found") return { routes: {}, collisions: [] };
    throw new Error(`cannot read ${channelsDir}: ${(error as Error).message}`);
  }
  const routes: Routes = {};
  const collisions: ChannelCollision[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (!CHANNEL_EXTS.has(ext) || entry.name.endsWith(".d.ts")) continue;
    const file = join(channelsDir, entry.name);
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    } catch (error) {
      throw new Error(
        `cannot load channels/${entry.name}: ${(error as Error).message}${moduleLoadHint(error as NodeJS.ErrnoException)}`,
      );
    }
    const factory = mod.default;
    if (typeof factory !== "function") {
      throw new Error(`channels/${entry.name} must default-export (agent) => Routes`);
    }
    let declared: Routes;
    try {
      declared = (factory as ChannelModule)(agent);
    } catch (error) {
      // A channel constructed at startup may reject a misconfig (e.g. an unset secret) — name the file.
      throw new Error(`channels/${entry.name}: ${(error as Error).message}`);
    }
    // The real invariant: an authored channels/ file must contribute at least one route. Assert that
    // directly rather than enumerating bad shapes — a Promise (async factory), a Map/Set, an array, a
    // primitive, or an empty object all yield zero Object.entries and would otherwise silently fall
    // back to /invoke; null/undefined would throw unwrapped.
    if (declared === null || typeof declared !== "object") {
      throw new Error(
        `channels/${entry.name} must return a Routes object, got ${declared === null ? "null" : typeof declared}`,
      );
    }
    const declaredRoutes = Object.entries(declared);
    if (declaredRoutes.length === 0) {
      throw new Error(
        `channels/${entry.name} declared no routes — return a non-empty { "METHOD /path": handler } object (a Promise, Map, array, or {} yields none)`,
      );
    }
    for (const [route, handler] of declaredRoutes) {
      if (typeof handler !== "function") {
        throw new Error(
          `channels/${entry.name}: route "${route}" must map to a handler function, got ${typeof handler}`,
        );
      }
      if (route in routes) {
        collisions.push({ route, source: `channels/${entry.name}` });
        continue;
      }
      routes[route] = handler;
    }
  }
  return { routes, collisions };
}
