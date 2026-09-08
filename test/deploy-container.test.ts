import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts } from "../src/deploy/container.ts";
import { piBasePrompt } from "../src/engines/pi/create.ts";

const input = {
  releaseId: "release-one",
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "0.0.0",
  agentPrefix: "fastagent/",
} as const;

describe("deploy/container: shared Docker context", () => {
  it("requires a safe nested definition", () => {
    expect(() => containerArtifacts({ ...input, agentPrefix: "" })).toThrow("nested agent");
    expect(() => containerArtifacts({ ...input, agentPrefix: "../agent/" })).toThrow("manifest");
  });
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

  it("gives each image a stable release and describes its persistent workspace", () => {
    const values = [input, { ...input, hasPackageJson: false }, { ...input, runtime: "bun" as const }]
      .map((i) => containerArtifacts(i).find((artifact) => artifact.path === "fastagent/Dockerfile")!.content)
      .map((content) => /^ENV FASTAGENT_RELEASE_FILE=(\S+)$/m.exec(content)?.[1]);
    expect(values).toEqual(Array(3).fill("/app/fastagent/fastagent.release.json"));
    const manifest = containerArtifacts(input).find((a) => a.path.endsWith("fastagent.release.json"))!;
    expect(JSON.parse(manifest.content)).toEqual({ version: 1, id: "release-one", agent: "fastagent" });
    const before = process.env.FASTAGENT_RELEASE_FILE;
    try {
      delete process.env.FASTAGENT_RELEASE_FILE;
      expect(piBasePrompt()).not.toContain("Your workspace survives restarts");
      process.env.FASTAGENT_RELEASE_FILE = values[0];
      expect(piBasePrompt()).toContain("Your workspace survives restarts, including uncommitted work");
      expect(piBasePrompt()).toContain("replaces your definition directory");
    } finally {
      if (before === undefined) delete process.env.FASTAGENT_RELEASE_FILE;
      else process.env.FASTAGENT_RELEASE_FILE = before;
    }
  });
});
