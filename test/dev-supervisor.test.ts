import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { devWatchIgnored } from "../src/dev-supervisor.ts";

describe("dev-supervisor: devWatchIgnored (the narrow watch scope)", () => {
  const root = join("/work", "agent");
  const ignored = devWatchIgnored(root);

  it("watches exactly the process-bound code inputs", () => {
    expect(ignored(root)).toBe(false); // the root itself must not be pruned
    expect(ignored(join(root, "tools"))).toBe(false);
    expect(ignored(join(root, "tools", "word-count.ts"))).toBe(false);
    expect(ignored(join(root, "tools", "lib", "helper.ts"))).toBe(false); // nested under tools/
    expect(ignored(join(root, "channels", "telegram.ts"))).toBe(false);
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
});
