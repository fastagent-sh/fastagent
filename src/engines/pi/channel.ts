/**
 * Channel discovery (the N axis, filesystem form): a workspace declares its inbound surface by
 * dropping files in `channels/`, mirroring `tools/`. Each file wires a third-party adapter to the
 * app's `on()` glue and returns the routes it mounts. There is no config-level channel list — a
 * channel always needs glue, so it is always a file.
 */
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ChannelContext, type ChannelModule, parseRouteKey, type Routes } from "../../host/node.ts";
import { assertInsideWorkspace } from "../../workspace.ts";
import { type ModuleLoadFailure, isModuleFile, loadModuleDir } from "../../loader.ts";

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
 * Discover channels in `<dir>/channels/`: each `*.ts|.js|.mjs` default-exports a `(ctx) => Routes`
 * factory ({@link ChannelModule}), called here with the mount context; the returned route maps are
 * merged (first file wins a route-key clash, the dropped route surfaced).
 *
 * A channel file broken for ANY reason — a failed import, a factory that throws when called (a missing
 * env var is the common deploy case), or a malformed shape (not a function, not a Routes object, a bad
 * handler/route key) — is collected in `failures` without preventing validation of sibling files. The
 * serving CLI treats any such failure as fatal: a declared channel must not silently disappear or cause
 * the default `/invoke` route to mount. Programmatic callers can inspect the returned data themselves.
 * Routes are validated fully before any merge, so a throw mounts no partial routes.
 */
export async function loadChannels(
  dir: string,
  ctx: ChannelContext,
): Promise<{ routes: Routes; collisions: ChannelCollision[]; failures: ModuleLoadFailure[] }> {
  // The contract says stateRoot is absolute; enforce it at the mount boundary so a relative root fails
  // fast HERE instead of silently re-anchoring some channel's state on the process cwd.
  if (!isAbsolute(ctx.stateRoot)) {
    throw new Error(`ChannelContext.stateRoot must be absolute, got "${ctx.stateRoot}"`);
  }
  // A symlinked channels/ is followed only if it stays inside the workspace, so a deploy that copies
  // the dir includes it (the directory is the agent).
  await assertInsideWorkspace(dir, "channels");
  const { modules, failures } = await loadModuleDir(join(dir, "channels"));
  const routes: Routes = {};
  const collisions: ChannelCollision[] = [];
  for (const { label, file, mod } of modules) {
    // Collect every per-file failure so the caller can report all broken channels in one pass. The CLI
    // then fails startup rather than silently dropping a declared route; direct callers own their policy.
    // Routes are VALIDATED fully before any are merged, so a throw mid-validation mounts NO partial routes.
    try {
      const factory = mod.default;
      if (typeof factory !== "function") {
        throw new Error(`${label} must default-export (ctx) => Routes`);
      }
      const declared = (factory as ChannelModule)(ctx) as unknown;
      // A Promise needs its own branch before the object check: mark it handled (a rejected async setup
      // must not go unhandled) and reject it with a precise message rather than the zero-routes one.
      if (
        declared !== null &&
        typeof declared === "object" &&
        typeof (declared as { then?: unknown }).then === "function"
      ) {
        (declared as Promise<unknown>).catch(() => {});
        throw new Error(`${label} must return Routes synchronously, not a Promise (an async factory is not supported)`);
      }
      if (declared === null || typeof declared !== "object") {
        throw new Error(`${label} must return a Routes object, got ${declared === null ? "null" : typeof declared}`);
      }
      const declaredRoutes = Object.entries(declared as Routes);
      if (declaredRoutes.length === 0) {
        throw new Error(
          `${label} declared no routes — return a non-empty { "METHOD /path": handler } object (a Promise, Map, array, or {} yields none)`,
        );
      }
      // Validate every route BEFORE merging any (no partial mount on a later throw).
      for (const [route, handler] of declaredRoutes) {
        if (typeof handler !== "function") {
          throw new Error(`${label}: route "${route}" must map to a handler function, got ${typeof handler}`);
        }
        if (!parseRouteKey(route).path.startsWith("/")) {
          throw new Error(`${label}: route "${route}" is not a valid route key (expected "METHOD /path" or "/path")`);
        }
      }
      for (const [route, handler] of declaredRoutes) {
        const parsed = parseRouteKey(route);
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
    } catch (error) {
      failures.push({ label, file, message: (error as Error).message });
    }
  }
  return { routes, collisions, failures };
}
