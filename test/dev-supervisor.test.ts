import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { devWatchIgnored } from "../src/dev-supervisor.ts";

describe("dev-supervisor: devWatchIgnored (the narrow watch scope)", () => {
  const root = join("/work", "agent");
  const ignored = devWatchIgnored(root, root); // flat: agentDir === cwd

  it("watches exactly the process-bound code inputs", () => {
    expect(ignored(root)).toBe(false); // the root itself must not be pruned
    expect(ignored(join(root, "tools"))).toBe(false);
    expect(ignored(join(root, "tools", "word-count.ts"))).toBe(false);
    expect(ignored(join(root, "tools", "lib", "helper.ts"))).toBe(false); // nested under tools/
    expect(ignored(join(root, "channels", "telegram.ts"))).toBe(false);
    expect(ignored(join(root, "schedules", "daily.ts"))).toBe(false); // loaded once per worker — restart is the re-read
    expect(ignored(join(root, "package.json"))).toBe(false);
    expect(ignored(join(root, ".env"))).toBe(false);
    expect(ignored(join(root, "fastagent.config.mjs"))).toBe(false);
    expect(ignored(join(root, "fastagent.config.ts"))).toBe(false);
  });

  it("ignores the definition (live-read per invoke) and anything the agent writes as work product", () => {
    expect(ignored(join(root, "AGENTS.md"))).toBe(true); // live-read — a restart would be strictly worse
    expect(ignored(join(root, "skills"))).toBe(true);
    expect(ignored(join(root, "skills", "house-style", "SKILL.md"))).toBe(true);
    expect(ignored(join(root, "report.md"))).toBe(true); // agent work product
    expect(ignored(join(root, "out"))).toBe(true); // pruned as a directory — its subtree costs nothing
    expect(ignored(join(root, ".fastagent"))).toBe(true);
    expect(ignored(join(root, "node_modules"))).toBe(true);
    expect(ignored(join(root, ".git"))).toBe(true);
  });

  it("root-file names elsewhere do not match (package.json in a subdir is not a code input)", () => {
    expect(ignored(join(root, "out", "package.json"))).toBe(true);
    expect(ignored(join(root, "docs", ".env"))).toBe(true);
  });

  it("agentDir subdir: the agent's tools/channels are watched; the host repo's own dirs are ignored", () => {
    const cwd = "/repo";
    const agentDir = join(cwd, "agent");
    const ig = devWatchIgnored(cwd, agentDir);
    expect(ig(agentDir)).toBe(false); // must descend into agentDir to reach its tools/
    expect(ig(join(agentDir, "tools", "foo.ts"))).toBe(false); // the agent's tool → restart
    expect(ig(join(agentDir, "channels", "telegram.ts"))).toBe(false);
    expect(ig(join(agentDir, "schedules", "daily.ts"))).toBe(false);
    expect(ig(join(agentDir, "package.json"))).toBe(false);
    expect(ig(join(agentDir, "persona.md"))).toBe(true); // live-read, no restart
    expect(ig(join(agentDir, "skills", "x", "SKILL.md"))).toBe(true);
    expect(ig(join(cwd, "tools", "hostonly.ts"))).toBe(true); // the HOST repo's tools/, NOT the agent's
    expect(ig(join(cwd, "src", "app.tsx"))).toBe(true); // host source ignored
    expect(ig(join(cwd, ".env"))).toBe(false); // run-root .env still watched
    expect(ig(join(cwd, "fastagent.config.mjs"))).toBe(false); // run-root config still watched
  });
});
