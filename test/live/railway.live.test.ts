/**
 * What the `railway` CLI actually prints, checked against the assumptions the Railway driver makes
 * about it. `deploy-railway-run.test.ts` drives the whole deploy against a fake `CliRunner` answering
 * what we believe it prints; that covers the orchestration and cannot cover the belief.
 *
 * The beliefs here are DATED: `isLinked`/`linkedName` carry "Verified against CLI 5.15.0" in their
 * comments, and the CLI is past 5.45. A version pin in a comment is exactly the kind of claim that
 * stops being true without anything going red — this file is what makes it go red.
 *
 * READ-ONLY. The write half lives in railway-deploy.live.test.ts, because `railway domain` MINTS a
 * domain when the service has none (it is the driver's getter and its allocator at once), so there is
 * no way to observe that one without provisioning something to observe it on.
 *
 * Needs `RAILWAY_API_TOKEN` — the ACCOUNT-scoped token, not the project-scoped `RAILWAY_TOKEN` a
 * Railway project hands out. Nothing in `src/` names either variable: the driver assumes an operator
 * who ran `railway login`, and CI has no such session.
 */
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isLinked, linkedName, parseHasVolume } from "../../src/deploy/railway/run.ts";
import { requireEnv } from "./env.ts";

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
    // Against a project this probe did NOT create: both readers are pure, and linking is local state
    // (a file in the directory), so nothing here writes to the account.
    const projects = parseJson<{ name?: string; deletedAt?: string | null }[]>(
      (await railway(["list", "--json"], tmpdir())).stdout,
      "list --json",
    );
    const alive = projects.find((p) => p.deletedAt === null && typeof p.name === "string")?.name;
    expect(alive, "this Railway account holds no live project to read against — create one").toBeTruthy();

    const dir = await mkdtemp(join(tmpdir(), "fa-live-railway-"));
    expect((await railway(["link", "--project", alive as string], dir)).code, `could not link ${alive}`).toBe(0);

    const status = await railway(["status", "--json"], dir);
    expect(isLinked(status.stdout), "a linked directory reads as unlinked").toBe(true);
    // `linkedName` only feeds a gate message, but a rename would make that message say "(name
    // unreadable)" about a project the operator can see by name in their dashboard.
    expect(linkedName(status.stdout), "`name` is no longer at the top level of status --json").toBe(alive);

    // `parseHasVolume` is shape-agnostic (any JSON string equal to the mount path), so what it needs is
    // for mount paths to keep appearing as strings at all. Asserted in both directions against the
    // volumes this project really has.
    const volumes = await railway(["volume", "list", "--json"], dir);
    const mounts =
      parseJson<{ volumes?: { mountPath?: string }[] }>(volumes.stdout, "volume list --json").volumes ?? [];
    for (const { mountPath } of mounts) {
      expect(parseHasVolume(volumes.stdout, mountPath as string), `mount ${mountPath} unreadable`).toBe(true);
    }
    expect(parseHasVolume(volumes.stdout, "/definitely-not-a-mount-path")).toBe(false);
  });
});
