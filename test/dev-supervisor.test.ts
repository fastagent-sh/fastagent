import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { devWatchIgnored } from "../src/dev-supervisor.ts";

describe("dev-supervisor: devWatchIgnored (the narrow watch scope)", () => {
  const root = join("/work", "agent");
  const ignored = devWatchIgnored(root, join(root, ".secrets", ".env"));

  it("watches exactly the process-bound code inputs", () => {
    expect(ignored(root)).toBe(false); // the root itself must not be pruned
    expect(ignored(join(root, "tools"))).toBe(false);
    expect(ignored(join(root, "tools", "word-count.ts"))).toBe(false);
    expect(ignored(join(root, "tools", "lib", "helper.ts"))).toBe(false); // nested under tools/
    expect(ignored(join(root, "channels", "telegram.ts"))).toBe(false);
    expect(ignored(join(root, "schedules", "daily.ts"))).toBe(false); // loaded once per worker — restart is the re-read
    expect(ignored(join(root, "package.json"))).toBe(false);
    expect(ignored(join(root, "fastagent.config.mjs"))).toBe(false);
    expect(ignored(join(root, "fastagent.config.ts"))).toBe(false);
    // models.json is loaded once per worker (the model hub is built during assembly) AND a malformed one
    // fails that assembly — unwatched, the edit that repairs a dead worker would not be the edit that
    // restarts it, so the author would be stranded with a correct file and a broken serve.
    expect(ignored(join(root, "models.json"))).toBe(false);
  });

  it(".secrets/.env is a code input (credentials are process-bound); the rest of .secrets is not", () => {
    expect(ignored(join(root, ".secrets"))).toBe(false); // the dir itself: descend, don't prune
    expect(ignored(join(root, ".secrets", ".env"))).toBe(false); // the trigger
    expect(ignored(join(root, ".secrets", "auth.json"))).toBe(true); // rewritten by refresh — no restart
    expect(ignored(join(root, ".secrets", ".env.example"))).toBe(true);
  });

  it("ignores the definition (live-read per invoke) and anything the agent writes as work product", () => {
    expect(ignored(join(root, "AGENTS.md"))).toBe(true); // live-read — a restart would be strictly worse
    expect(ignored(join(root, "skills"))).toBe(true);
    expect(ignored(join(root, "skills", "house-style", "SKILL.md"))).toBe(true);
    expect(ignored(join(root, "report.md"))).toBe(true); // agent work product
    expect(ignored(join(root, "out"))).toBe(true); // pruned as a directory — its subtree costs nothing
    expect(ignored(join(root, ".state"))).toBe(true);
    expect(ignored(join(root, "node_modules"))).toBe(true);
    expect(ignored(join(root, ".git"))).toBe(true);
  });

  it("root-file names elsewhere do not match (package.json in a subdir is not a code input)", () => {
    expect(ignored(join(root, "out", "package.json"))).toBe(true);
    expect(ignored(join(root, "docs", ".env"))).toBe(true);
  });

  it("the watch root is the AGENT DIR — the surrounding workspace never enters the scope", () => {
    // The supervisor watches resolvePlacement().agentDir (= <workspace>/fastagent), so the workspace's
    // own files are structurally out of scope: they are never passed to the matcher at all.
    const nestedRoot = join("/repo", "fastagent");
    const ig = devWatchIgnored(nestedRoot, join(nestedRoot, ".secrets", ".env"));
    expect(ig(nestedRoot)).toBe(false);
    expect(ig(join(nestedRoot, "tools", "foo.ts"))).toBe(false);
    expect(ig(join(nestedRoot, "persona.md"))).toBe(true); // live-read, no restart
    expect(ig(join(nestedRoot, ".secrets", ".env"))).toBe(false);
  });
});

describe("dev-supervisor: the watched .env follows FASTAGENT_SECRETS_DIR", () => {
  const root = "/agent";
  it("allow-lists the RESOLVED .env and its ancestors; siblings still prune", () => {
    const ig = devWatchIgnored(root, "/agent/creds/.env"); // an in-agent dir not named .secrets
    expect(ig("/agent/creds")).toBe(false); // descend
    expect(ig("/agent/creds/.env")).toBe(false); // watched
    expect(ig("/agent/creds/auth.json")).toBe(true); // rotation must not restart the worker
    expect(ig("/agent/.secrets/.env")).toBe(true); // the default name is NOT special
  });

  it("prunes everything when the .env resolves outside the agent (the supervisor warns instead)", () => {
    const ig = devWatchIgnored(root, "/data/.secrets/.env");
    expect(ig("/agent/.secrets/.env")).toBe(true);
    expect(ig("/agent/tools/x.ts")).toBe(false); // code inputs unaffected
  });
});
