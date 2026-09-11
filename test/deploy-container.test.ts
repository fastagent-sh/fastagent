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

  it("records a value-file model in the release manifest, and nothing when the config named it", () => {
    // The carrier is the manifest, not the Dockerfile: every host writes it unconditionally (`alwaysWrite`), it is
    // rewritten by every deploy so it cannot go stale, and nothing on the way in can interpolate a shell.
    const manifest = (i: typeof input & { modelSpec?: string }) =>
      JSON.parse(containerArtifacts(i).find((a) => a.path.endsWith("fastagent.release.json"))!.content);
    expect(manifest({ ...input, modelSpec: "baseten/zai-org/GLM-5.3" })).toEqual({
      version: 1,
      id: "release-one",
      agent: "fastagent",
      model: "baseten/zai-org/GLM-5.3",
    });
    expect(manifest(input).model).toBeUndefined();
    // It is NOT in the image's instructions — a credential could never ride this carrier, and neither does this.
    const dockerfile = containerArtifacts({ ...input, modelSpec: "openai/gpt-4o-mini" }).find(
      (a) => a.path === "fastagent/Dockerfile",
    )!.content;
    expect(dockerfile).not.toContain("FASTAGENT_MODEL");
  });

  it("gives each image a stable release and describes its persistent workspace", () => {
    const values = [input, { ...input, hasPackageJson: false }, { ...input, runtime: "bun" as const }]
      .map((i) => containerArtifacts(i).find((artifact) => artifact.path === "fastagent/Dockerfile")!.content)
      .map((content) => /^ENV FASTAGENT_RELEASE_FILE=(\S+)$/m.exec(content)?.[1]);
    expect(values).toEqual(Array(3).fill("/app/fastagent/fastagent.release.json"));
    const manifest = containerArtifacts(input).find((a) => a.path.endsWith("fastagent.release.json"))!;
    expect(JSON.parse(manifest.content)).toEqual({ version: 1, id: "release-one", agent: "fastagent" });
    const before = process.env.FASTAGENT_RELEASE_FILE;
    const beforeAgentcore = process.env.FASTAGENT_AGENTCORE;
    try {
      delete process.env.FASTAGENT_RELEASE_FILE;
      delete process.env.FASTAGENT_AGENTCORE;
      expect(piBasePrompt()).not.toContain("Your workspace survives");
      process.env.FASTAGENT_RELEASE_FILE = values[0];
      expect(piBasePrompt()).toContain("Your workspace survives restarts and deployments");
      expect(piBasePrompt()).toContain("replaces your definition directory");
      // The host whose storage a deploy RESETS must not be told that work outside the definition
      // survives one — that would name a location its next deploy erases.
      process.env.FASTAGENT_AGENTCORE = "1";
      expect(piBasePrompt()).not.toContain("survives restarts and deployments");
      expect(piBasePrompt()).toContain("resets this host's storage entirely");
    } finally {
      for (const [key, value] of [
        ["FASTAGENT_RELEASE_FILE", before],
        ["FASTAGENT_AGENTCORE", beforeAgentcore],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
