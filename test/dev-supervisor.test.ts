import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { devChangeRestarts, devWatchIgnored } from "../src/dev-supervisor.ts";

describe("dev-supervisor: devWatchIgnored (the narrow watch scope)", () => {
  const root = join("/work", "agent");
  const ignored = devWatchIgnored(root, join(root, ".secrets", ".env"));

  it("watches exactly the process-bound code inputs", () => {
    expect(ignored(root)).toBe(false); // the root itself must not be pruned
    // Everything under tools/ a tool could import stays in scope — whether it restarts is devChangeRestarts' call —
    // and a directory must stay in scope for its files to be asked about at all.
    expect(ignored(join(root, "tools", "word-count.ts"))).toBe(false);
    expect(ignored(join(root, "tools", "word-count.js"))).toBe(false);
    expect(ignored(join(root, "tools", "lib"))).toBe(false);
    expect(ignored(join(root, "tools", "lib", "data.json"))).toBe(false);
    // Nothing imports these, so they change nothing.
    expect(ignored(join(root, "tools", "README.md"))).toBe(true);
    expect(ignored(join(root, "tools", ".word-count.ts.swp"))).toBe(true);
    expect(ignored(join(root, "channels", "telegram.ts"))).toBe(false);
    expect(ignored(join(root, "routines", "daily.ts"))).toBe(false); // loaded once per worker — restart is the re-read
    // Which FILES are extensions is decided at boot, so an added or removed entry needs the restart
    // this watcher exists to give. (Their per-turn reload is a different thing and does not help:
    // it re-instantiates the set discovered at boot.)
    expect(ignored(join(root, "extensions", "notify.ts"))).toBe(false);
    expect(ignored(join(root, "extensions", "notify", "index.ts"))).toBe(false);
    expect(ignored(join(root, "package.json"))).toBe(false);
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

  it("ignores imported helpers outside watched code directories", () => {
    expect(ignored(join(root, "lib"))).toBe(true);
    expect(ignored(join(root, "lib", "batches.ts"))).toBe(true);
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
    expect(ig(join(nestedRoot, "channels", "foo.ts"))).toBe(false);
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
    expect(ig("/agent/channels/x.ts")).toBe(false); // code inputs unaffected
  });
});

describe("dev-supervisor: devChangeRestarts (which watched change costs the worker its process)", () => {
  const root = join("/work", "agent");

  it("TypeScript under tools/ reloads in the serving worker, so it restarts nothing", () => {
    expect(devChangeRestarts(root, join(root, "tools", "greet.ts"), { serving: true, routinesAtBoot: true })).toBe(
      false,
    );
    expect(
      devChangeRestarts(root, join(root, "tools", "lib", "word.ts"), { serving: true, routinesAtBoot: true }),
    ).toBe(false);
  });

  it("nor does a directory under tools/ — an agent's first helper creates tools/lib/ in the middle of its turn", () => {
    // chokidar reports it as `addDir`/`unlinkDir`; with no extension it is neither code nor cached code.
    expect(devChangeRestarts(root, join(root, "tools", "lib"), { serving: true, routinesAtBoot: true })).toBe(false);
  });

  it("the FIRST routine restarts a worker that booted with none — POST /run exists only from boot", () => {
    expect(devChangeRestarts(root, join(root, "routines", "daily.ts"), { serving: true, routinesAtBoot: false })).toBe(
      true,
    );
    // ...but not a helper directory beside it, and nothing under tools/.
    expect(devChangeRestarts(root, join(root, "routines", "lib"), { serving: true, routinesAtBoot: false })).toBe(
      false,
    );
    expect(devChangeRestarts(root, join(root, "tools", "greet.ts"), { serving: true, routinesAtBoot: false })).toBe(
      false,
    );
  });

  it("routines/ is live code too: its TypeScript re-arms in the serving worker, a cached format restarts it", () => {
    expect(devChangeRestarts(root, join(root, "routines", "daily.ts"), { serving: true, routinesAtBoot: true })).toBe(
      false,
    );
    expect(devChangeRestarts(root, join(root, "routines", "daily.mjs"), { serving: true, routinesAtBoot: true })).toBe(
      true,
    );
    expect(devChangeRestarts(root, join(root, "routines", "daily.ts"), { serving: false, routinesAtBoot: true })).toBe(
      true,
    );
  });

  it("with the worker DOWN it restarts — the worker refused a broken tool at boot, and this may be the fix", () => {
    expect(devChangeRestarts(root, join(root, "tools", "greet.ts"), { serving: false, routinesAtBoot: true })).toBe(
      true,
    );
  });

  it("a format Node caches, and every other code input, restart the serving worker", () => {
    expect(
      devChangeRestarts(root, join(root, "tools", "lib", "data.json"), { serving: true, routinesAtBoot: true }),
    ).toBe(true);
    expect(
      devChangeRestarts(root, join(root, "channels", "telegram.ts"), { serving: true, routinesAtBoot: true }),
    ).toBe(true);
    expect(devChangeRestarts(root, join(root, "fastagent.config.ts"), { serving: true, routinesAtBoot: true })).toBe(
      true,
    );
  });
});
