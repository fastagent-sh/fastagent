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
      // Same two hints as tools/: a missing dependency, or a non-ESM workspace.
      const e = error as NodeJS.ErrnoException;
      const hint =
        e.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(e.message)
          ? `  (a dependency is not installed — run \`npm install\` in the workspace)`
          : `  (a channel workspace must be ESM — set "type": "module" in package.json)`;
      throw new Error(`cannot load channels/${entry.name}: ${e.message}\n${hint}`);
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
    // The contract is synchronous `(agent) => Routes`. An async factory (easy to write in an untyped
    // .js/.mjs) returns a Promise whose Object.entries is empty — it would silently mount no routes
    // and fall back to /invoke. Reject it visibly instead.
    if (declared && typeof (declared as { then?: unknown }).then === "function") {
      throw new Error(`channels/${entry.name} must return Routes synchronously, not a Promise`);
    }
    for (const [route, handler] of Object.entries(declared)) {
      if (route in routes) {
        collisions.push({ route, source: `channels/${entry.name}` });
        continue;
      }
      routes[route] = handler;
    }
  }
  return { routes, collisions };
}
