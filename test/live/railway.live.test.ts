/**
 * What the `railway` CLI actually prints, checked against the assumptions the Railway driver makes
 * about it. `deploy-railway-run.test.ts` drives the whole deploy against a fake `CliRunner` answering
 * what we believe it prints; that covers the orchestration and cannot cover the belief.
 *
 * The beliefs here are DATED: `isLinked`/`linkedName` carry "Verified against CLI 5.15.0" in their
 * comments, and the CLI is past 5.45. A version pin in a comment is exactly the kind of claim that
 * stops being true without anything going red — this file is what makes it go red.
 *
 * The shape half, and READ-ONLY: it links {@link RAILWAY_PROBE_PROJECT} and reads. The DEPLOY half
 * lives in railway-deploy.live.test.ts, because `railway domain` MINTS a domain when the service has
 * none (it is the driver's getter and its allocator at once), so there is no way to observe that one
 * without provisioning something to observe it on.
 *
 * Being read-only took two corrections. It first linked whatever live project the account happened to
 * hold — a probe reaching for something that is not its own, which held only until the account ran out
 * of leftovers and it linked the operator's REAL project. Owning a project per run fixed that and cost
 * the read-only property: it had to CREATE something purely to have something linked. A standing
 * project shared with the deploy probe is both — its own, and nothing this run has to make.
 *
 * Needs `RAILWAY_API_TOKEN` — the ACCOUNT-scoped token, not the project-scoped `RAILWAY_TOKEN` a
 * Railway project hands out. The driver never reads it: it assumes an operator who ran `railway login`
 * and only NAMES the variable in its gate message (`run.ts`), so in CI the token stands in for that
 * session.
 */
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isLinked, linkedName, parseHasVolume } from "../../src/deploy/railway/run.ts";
import { RAILWAY_PROBE_PROJECT, requireEnv } from "./env.ts";

const run = promisify(execFile);

requireEnv("RAILWAY_API_TOKEN", "an ACCOUNT-scoped Railway token (Account Settings → Tokens)");

/** One railway invocation from `cwd`, capturing both streams and the exit code — none of the three is
 *  incidental here: the driver reads stdout only, and this file is what proves that is still right. */
async function railway(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("railway", args, { cwd, maxBuffer: 64 << 20 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Parse, or fail with what was actually printed. A bare `SyntaxError: Unexpected token` names neither
 *  the command nor the output, and this probe has already seen one transient non-JSON answer. */
function parseJson<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(`\`railway ${what}\` did not return JSON (${String(error)}): ${stdout.slice(0, 300)}`);
  }
}

/** Created on first use, so a fresh account — or one where it was deleted — needs no manual setup.
 *  `== null`, not `=== null`: a MISSING deletedAt must read as alive, or this would create a second
 *  project beside a perfectly good one on every run. */
async function ensureProbeProject(): Promise<void> {
  const listed = await railway(["list", "--json"], tmpdir());
  const projects = parseJson<{ name?: string; deletedAt?: string | null }[]>(listed.stdout, "list --json");
  if (projects.some((project) => project.name === RAILWAY_PROBE_PROJECT && project.deletedAt == null)) return;
  const dir = await mkdtemp(join(tmpdir(), "fa-live-railway-"));
  const created = await railway(["init", "--name", RAILWAY_PROBE_PROJECT], dir);
  if (created.code !== 0) throw new Error(`could not create ${RAILWAY_PROBE_PROJECT}: ${created.stderr.trim()}`);
}

describe("railway CLI output still matches what the Railway driver reads", () => {
  it("an UNLINKED directory leaves stdout empty — the whole basis of isLinked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-railway-"));
    const { code, stdout, stderr } = await railway(["status", "--json"], dir);

    // THE assertion. `isLinked` is `stdout.trim() !== ""`, so an unlinked directory that started
    // printing anything to stdout would read as linked and the driver would refuse to provision,
    // telling the operator their fresh directory belongs to a project.
    expect(stdout.trim(), "an unlinked `railway status --json` now writes to stdout").toBe("");
    expect(isLinked(stdout)).toBe(false);
    expect(stderr.trim(), "the unlinked message no longer goes to stderr").not.toBe("");

    // The comment on `isLinked` says the exit code "is 0 either way, so it can't be the signal".
    // Measured on 5.45.2 it is NOT 0 — which does not break the driver (it reads stdout alone) and is
    // recorded here so the reasoning stays honest rather than the conclusion staying lucky.
    expect([0, 1], `unexpected exit code ${code} for an unlinked status`).toContain(code);
  });

  it("`list --json` is an array of projects carrying id, name and deletedAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-railway-"));
    const { stdout } = await railway(["list", "--json"], dir);
    const projects = parseJson<{ id?: string; name?: string; deletedAt?: string | null }[]>(stdout, "list --json");
    expect(Array.isArray(projects), "`railway list --json` is no longer an array").toBe(true);

    // Teardown in the deploy probe needs all three: the name to find its own project, the id because
    // `delete` takes one, and deletedAt because Railway deletes SOFTLY — a destroyed project keeps
    // being listed, so "still present" is not evidence of a leak.
    for (const project of projects) {
      expect(typeof project.name, `a project entry carries no name: ${JSON.stringify(project)}`).toBe("string");
      expect(typeof project.id, `project ${project.name} carries no id`).toBe("string");
      expect(project, `project ${project.name} carries no deletedAt`).toHaveProperty("deletedAt");
    }
  });

  it("`linkedName` and `parseHasVolume` read a linked project's shape", async () => {
    await ensureProbeProject();
    const dir = await mkdtemp(join(tmpdir(), "fa-live-railway-"));
    // `--environment` too: interactive `link` prompts for workspace, project AND environment, and the
    // docs' non-interactive form passes both. `production` is the environment Railway gives every new
    // project — a project that renamed it fails here by name rather than by an unreadable prompt.
    const link = await railway(["link", "--project", RAILWAY_PROBE_PROJECT, "--environment", "production"], dir);
    expect(link.code, `could not link ${RAILWAY_PROBE_PROJECT}: ${link.stderr.trim()}`).toBe(0);

    const status = await railway(["status", "--json"], dir);
    expect(isLinked(status.stdout), "a linked directory reads as unlinked").toBe(true);
    // `linkedName` only feeds a gate message, but a rename would make that message say "(name
    // unreadable)" about a project the operator can see by name in their dashboard.
    expect(linkedName(status.stdout), "`name` is no longer at the top level of status --json").toBe(
      RAILWAY_PROBE_PROJECT,
    );

    // `parseHasVolume` is shape-agnostic (any JSON string equal to the mount path), so what it needs is
    // for mount paths to keep appearing as strings at all. Asserted in both directions against the
    // volumes this project really has.
    const volumes = await railway(["volume", "list", "--json"], dir);
    // The `volumes` key must EXIST. `?? []` would have folded "the field is gone" into "this project
    // has no volumes": the loop runs zero times, only the always-false negative assertion is left, and
    // the shape change this file exists to catch goes green.
    const mounts = parseJson<{ volumes?: { mountPath?: string }[] }>(volumes.stdout, "volume list --json").volumes;
    if (!Array.isArray(mounts))
      throw new Error(
        `\`railway volume list --json\` no longer carries a volumes array: ${volumes.stdout.slice(0, 300)}`,
      );
    for (const { mountPath } of mounts) {
      expect(parseHasVolume(volumes.stdout, mountPath as string), `mount ${mountPath} unreadable`).toBe(true);
    }
    expect(parseHasVolume(volumes.stdout, "/definitely-not-a-mount-path")).toBe(false);
  });
});
