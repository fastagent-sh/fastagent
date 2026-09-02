/**
 * What `flyctl` actually prints, checked against the assumptions the Fly driver makes about it.
 *
 * `deploy-fly-run.test.ts` drives the whole deploy against a fake `CliRunner` that answers what we
 * believe `flyctl` prints today. That covers the orchestration — the order of operations, the gates,
 * which failure stops what — and cannot cover the belief itself. When Fly ships a CLI that renames a
 * field or stops emitting JSON, every one of those tests stays green while `deploy fly --run` starts
 * misreading its own tooling.
 *
 * READ-ONLY, on purpose. The driver's write steps (`apps create`, `volumes create`, `secrets import`,
 * `deploy`) are what cost money and leave resources behind; its read steps are where the parsing
 * assumptions live, and they are free. What a real deploy would add on top of this — that pushing an
 * image succeeds — is largely covered by docker.live.test.ts, which builds and boots the SAME
 * generated Dockerfile through the SAME serving path.
 *
 * Needs `FLY_API_TOKEN` (`flyctl auth token`) and `flyctl` on PATH. No write scope is exercised.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { listHasName } from "../../src/deploy/fly/run.ts";
import { requireEnv } from "./env.ts";

const run = promisify(execFile);

// flyctl reads this itself; the probe only asserts it is present so a missing token fails by name
// rather than as an opaque `auth whoami` exit code.
requireEnv("FLY_API_TOKEN", "a Fly API token from `flyctl auth token`");

/** One read-only flyctl invocation, failing loudly: a non-zero exit is a broken assumption, not a case
 *  to absorb. `maxBuffer` because an account with many apps prints more than the 1 MB default. */
async function flyctl(args: string[]): Promise<string> {
  const { stdout } = await run("flyctl", args, { maxBuffer: 64 << 20 });
  return stdout;
}

describe("flyctl output still matches what the Fly driver reads", () => {
  it("authenticates with the token the driver expects to inherit", async () => {
    // The driver's first gate is `auth whoami`; it only reads the exit code, so this asserts the same
    // thing it does — that the ambient token works — before anything downstream is meaningful.
    const who = await flyctl(["auth", "whoami"]);
    expect(who.trim(), "auth whoami printed nothing").not.toBe("");
  });

  it("`apps list --json` parses, and listHasName agrees with it in both directions", async () => {
    const stdout = await flyctl(["apps", "list", "--json"]);
    const apps = JSON.parse(stdout) as { Name?: string; name?: string }[];
    expect(Array.isArray(apps), "apps list --json is no longer a JSON array").toBe(true);

    // The negative direction holds on any account, empty or not.
    expect(listHasName(stdout, `fastagent-live-absent-${randomUUID()}`)).toBe(false);

    // The positive direction is what pins the FIELD NAME — the driver accepts `Name` or `name`, and a
    // rename to anything else would silently make every app look absent, sending the driver into
    // `apps create` for an app that already exists.
    const first = apps[0];
    if (first) {
      const name = first.Name ?? first.name;
      expect(name, "an app entry carries neither Name nor name").toBeTruthy();
      expect(listHasName(stdout, name as string), "listHasName cannot find an app that is listed").toBe(true);
    }
  });

  it("`volumes list --json` parses through the same reader", async () => {
    // listHasName serves BOTH lists, so a divergence between the two shapes would break volume
    // detection while apps still worked — the driver would try to create an existing volume.
    const apps = JSON.parse(await flyctl(["apps", "list", "--json"])) as { Name?: string; name?: string }[];
    const app = apps[0]?.Name ?? apps[0]?.name;
    if (!app) return; // nothing to list against; the apps assertions above already covered the reader

    const stdout = await flyctl(["volumes", "list", "-a", app, "--json"]);
    expect(Array.isArray(JSON.parse(stdout)), "volumes list --json is no longer a JSON array").toBe(true);
    expect(listHasName(stdout, `absent-${randomUUID()}`)).toBe(false);
  });
});
