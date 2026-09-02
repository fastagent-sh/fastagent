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
import { hasIngressAddress, listHasName } from "../../src/deploy/fly/run.ts";
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

/** The app the per-app readers run against. An EMPTY org is a failure, not a case to return from:
 *  these assertions would then pass while checking nothing, which is exactly what test/live/env.ts
 *  refuses. The deploy probe destroys the app it creates, so a dedicated org needs one app of its
 *  own kept around — any app will do; nothing here writes to it. */
function requireApp(apps: { Name?: string; name?: string }[]): string {
  const app = apps[0]?.Name ?? apps[0]?.name;
  expect(app, "this Fly org holds no app to read against — create one (any app) so these assertions run").toBeTruthy();
  return app as string;
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

  it("`ips list --json` still carries Address AND Type, which decide whether the deploy allocates", async () => {
    // The newest parsing assumption here (#425): reading this wrong in the "has an address" direction
    // ships an app nobody can reach, and in the other direction allocates a second address every run.
    const apps = JSON.parse(await flyctl(["apps", "list", "--json"])) as { Name?: string; name?: string }[];
    const app = requireApp(apps);

    const stdout = await flyctl(["ips", "list", "-a", app, "--json"]);
    const ips = JSON.parse(stdout) as { Address?: string; Type?: string }[];
    expect(Array.isArray(ips), "ips list --json is no longer a JSON array").toBe(true);

    // `Type` is HALF the reading, and the half a non-empty `Address` hides: Flycast (`private_v6`)
    // and egress addresses are assignments that reach nothing. A renamed or dropped Type would make
    // every one of them read as ingress, which is #425 on an app that already has an address.
    const known = ["v4", "v6", "shared_v4", "private_v6", "egress_v4", "egress_v6", "egress_pair"];
    for (const ip of ips) expect(known, `ips list --json carries an unknown Type ${ip.Type}`).toContain(ip.Type);

    // An account's first app is one this probe did not create, so it may legitimately have no public
    // address; assert the reader agrees with the payload either way rather than assuming a state.
    const isPublic = (ip: { Address?: string; Type?: string }) =>
      typeof ip.Address === "string" && ip.Address !== "" && ["v4", "v6", "shared_v4"].includes(ip.Type as string);
    expect(hasIngressAddress(stdout)).toBe(ips.some(isPublic));
    expect(hasIngressAddress("[]"), "an app with no addresses must read as unallocated").toBe(false);
  });

  it("`volumes list --json` parses through the same reader", async () => {
    // listHasName serves BOTH lists, so a divergence between the two shapes would break volume
    // detection while apps still worked — the driver would try to create an existing volume.
    const apps = JSON.parse(await flyctl(["apps", "list", "--json"])) as { Name?: string; name?: string }[];
    const app = requireApp(apps);

    const stdout = await flyctl(["volumes", "list", "-a", app, "--json"]);
    expect(Array.isArray(JSON.parse(stdout)), "volumes list --json is no longer a JSON array").toBe(true);
    expect(listHasName(stdout, `absent-${randomUUID()}`)).toBe(false);
  });
});
