/**
 * The PUBLISHED artifact, installed from the registry — the one thing CI's `npm pack` smoke cannot
 * see. Between a green pack job and a user's `npm i` sit the `files` field, the publish pipeline and
 * the postbuild asset copy (scripts/copy-scaffold-assets.mjs): a scaffold payload that never reaches
 * the tarball makes `init` produce a half-empty agent, and every offline test stays green.
 *
 * Defaults to this checkout's version — after a release, that is the version just published.
 * `FASTAGENT_LIVE_VERSION` points it at any other (a dist-tag works too).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { exists } from "../../src/paths.ts";
import { liveVersion } from "./env.ts";

const run = promisify(execFile);
const VERSION = await liveVersion();
const PACKAGE = "@fastagent-sh/fastagent";

describe(`published ${PACKAGE}@${VERSION}`, () => {
  it("installs from the registry and scaffolds a complete agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-registry-"));
    await run("npm", ["init", "-y"], { cwd: dir });
    // --ignore-scripts: a consumer install runs no build of ours, so the tarball must already be whole.
    await run("npm", ["install", `${PACKAGE}@${VERSION}`, "--ignore-scripts"], { cwd: dir });

    const cli = join(dir, "node_modules", ".bin", "fastagent");
    const { stdout } = await run(cli, ["--version"], { cwd: dir });
    expect(stdout.trim()).toBe(VERSION);

    // --no-install: the scaffold's own npm install would re-fetch the same package for nothing.
    await run(cli, ["init", "demo", "--no-install"], { cwd: dir });
    const agent = join(dir, "demo", "fastagent");
    for (const file of ["persona.md", "fastagent.config.mjs", "package.json", "tools/fetch-url.ts"]) {
      expect(await exists(join(agent, file)), `init did not produce ${file}`).toBe(true);
    }
    // The skill is a DIRECTORY in the payload — the shape most likely to be lost by a copy step.
    expect(await exists(join(agent, "skills", "writing-great-skills", "SKILL.md"))).toBe(true);
    expect(await readFile(join(agent, "persona.md"), "utf8")).not.toBe("");

    // Channel bundles are copied by the same postbuild step, from a different source root
    // (src/channels/<kind>/scaffold). `add <kind>` for slack/feishu/lark talks to the platform, so
    // the payload is asserted where it lands rather than through an onboarding flow.
    const dist = join(dir, "node_modules", PACKAGE, "dist");
    for (const kind of ["telegram", "slack", "feishu", "lark", "github"]) {
      expect(await exists(join(dist, "channels", kind, "scaffold")), `${kind} scaffold missing from the tarball`).toBe(
        true,
      );
    }
  });
});
