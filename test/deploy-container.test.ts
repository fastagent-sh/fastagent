import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts } from "../src/deploy/container.ts";
import { piBasePrompt } from "../src/engines/pi/create.ts";

const input = {
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "0.0.0",
  agentPrefix: "fastagent/",
} as const;

describe("deploy/container: shared Docker context", () => {
  it("keeps tracked secrets scaffolds without shipping credentials or state", () => {
    const artifacts = containerArtifacts(input);
    const rootIgnore = artifacts.find((artifact) => artifact.path === ".dockerignore")!.content;
    const dockerfileIgnore = artifacts.find(
      (artifact) => artifact.path === "fastagent/Dockerfile.dockerignore",
    )!.content;

    expect(dockerfileIgnore).toBe(rootIgnore);
    expect(rootIgnore).toMatch(/^\*\*\/\.secrets\/\*\*$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.env\.example$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.secrets\/\.gitignore$/m);
    expect(rootIgnore).not.toMatch(/^\*\*\/\.secrets$/m);

    // Excluding descendants rather than the directory keeps these negations meaningful in both
    // Docker's matcher and the stricter gitignore-style matcher used by deploy preflight.
    const ignored = ignore({ ignorecase: false }).add(rootIgnore);
    const ships = (path: string): boolean => !ignored.ignores(path);
    const tracked = [
      "README.md",
      "fastagent/.secrets/.env.example",
      "fastagent/.secrets/.gitignore",
      ".secrets/.env.example",
      ".secrets/.gitignore",
    ];
    const sensitive = [
      "fastagent/.secrets/.env",
      "fastagent/.secrets/auth.json",
      "fastagent/.secrets/nested/token",
      "fastagent/.state/sessions/session.jsonl",
      ".secrets/.env",
      ".state/channels/telegram.json",
    ];

    // With .git shipped, this difference is the set `git ls-files --deleted` would report after COPY.
    expect(tracked.filter((path) => !ships(path))).toEqual([]);
    expect(sensitive.filter(ships)).toEqual([]);
    expect(ships(".git/HEAD")).toBe(true);
  });

  // The two halves live on opposite sides of the deploy/runtime boundary and are joined by a literal
  // env name (like FASTAGENT_AGENTCORE), so they are asserted together: a marker only one side writes
  // is a silently missing warning inside a container nobody reads the prompt of.
  it("marks the image baked, and the base prompt turns that marker into the write-back rule", () => {
    const values = [input, { ...input, hasPackageJson: false }, { ...input, runtime: "bun" as const }]
      .map((i) => containerArtifacts(i).find((artifact) => artifact.path === "fastagent/Dockerfile")!.content)
      .map((content) => /^ENV FASTAGENT_DEPLOYED=(\S+)$/m.exec(content)?.[1]);
    expect(values).toEqual(["1", "1", "1"]);

    const before = process.env.FASTAGENT_DEPLOYED;
    try {
      delete process.env.FASTAGENT_DEPLOYED;
      expect(piBasePrompt()).not.toContain("BAKED");
      process.env.FASTAGENT_DEPLOYED = values[0];
      expect(piBasePrompt()).toContain("BAKED into this deployment's image");
      expect(piBasePrompt()).toContain("commit and push it in the same turn");
    } finally {
      if (before === undefined) delete process.env.FASTAGENT_DEPLOYED;
      else process.env.FASTAGENT_DEPLOYED = before;
    }
  });
});
