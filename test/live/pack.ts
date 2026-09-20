/**
 * `globalSetup` for the live run: pack THIS checkout, once, and hand every probe the tarball.
 *
 * WHY IT IS HERE AND NOT IN A PROBE. `vitest.live.config.ts` runs `pool: "forks"` with the default
 * `isolate: true`, so a module-level memo is scoped to ONE test file. Five deploy probes asking
 * `installSpec` would each run `npm pack` — and `prepack → prebuild` is `rm -rf dist` plus a full
 * `tsc`, so that is five complete builds per live run, each one deleting the working tree's `dist/`
 * again. `globalSetup` is the only scope the whole run shares; its `process.env` mutations reach the
 * workers because they are forked after it (asserted by the probes simply finding the variable).
 *
 * The build still removes `dist/` once. That is `prepack`'s doing, not ours, and a live run is a
 * minutes-long affair — but it is why this is not something to invoke casually.
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./env.ts";

/** Where {@link installSpec} reads the tarball from. Set here; nothing else writes it. */
export const TARBALL_ENV = "FASTAGENT_LIVE_TARBALL";

export default async function packCheckout(): Promise<void> {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const out = await mkdtemp(join(tmpdir(), "fastagent-live-pack-"));
  // THE DESTINATION DIRECTORY IS THE ANSWER, rather than `--json` on stdout. npm's own lifecycle banner
  // goes to stderr, but the scripts `prepack` runs do not have to: `tsc` writes its diagnostics to
  // stdout, and one `console.log` added to `postbuild` some day would turn this into
  // `Unexpected token 's'` — an error naming nothing that is wrong. An empty directory is unambiguous.
  await run("npm", ["pack", "--pack-destination", out], repo);
  const tarballs = (await readdir(out)).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `npm pack left ${tarballs.length} tarballs in ${out}, expected exactly one: ${tarballs.join(", ")}`,
    );
  }
  process.env[TARBALL_ENV] = join(out, tarballs[0] as string);
}
