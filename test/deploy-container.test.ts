import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts } from "../src/deploy/container.ts";
import { fastagentPromptSections } from "../src/engines/pi/create.ts";
import type { MountedTool } from "../src/engines/pi/tool.ts";

const input = {
  releaseId: "release-one",
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "0.0.0",
  agent: "reviewer",
} as const;

describe("deploy/container: shared Docker context", () => {
  it("refuses an agent name the release manifest could not carry", () => {
    expect(() => containerArtifacts({ ...input, agent: "../agent" })).toThrow("manifest");
  });
  it("keeps tracked secrets scaffolds without shipping credentials or state", () => {
    const artifacts = containerArtifacts(input);
    const rootIgnore = artifacts.find((artifact) => artifact.path === ".dockerignore")!.content;
    const dockerfileIgnore = artifacts.find((artifact) => artifact.path === "Dockerfile.dockerignore")!.content;

    expect(dockerfileIgnore).toBe(rootIgnore);
    expect(rootIgnore).toMatch(/^\*\*\/\.secrets\/\*\*$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.env\.example$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.secrets\/\.gitignore$/m);
    expect(rootIgnore).not.toMatch(/^\*\*\/\.secrets$/m);

    // Excluding descendants rather than the directory keeps these negations meaningful in both
    // Docker's matcher and the stricter gitignore-style matcher used by deploy preflight.
    const ignored = ignore({ ignorecase: false }).add(rootIgnore);
    const ships = (path: string): boolean => !ignored.ignores(path);
    const tracked = ["README.md", ".secrets/.env.example", ".secrets/.gitignore"];
    const sensitive = [
      ".secrets/.env",
      ".secrets/auth.json",
      ".secrets/nested/token",
      ".state/sessions/session.jsonl",
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
      agent: "reviewer",
      model: "baseten/zai-org/GLM-5.3",
    });
    expect(manifest(input).model).toBeUndefined();
    // It is NOT in the image's instructions — a credential could never ride this carrier, and neither does this.
    const dockerfile = containerArtifacts({ ...input, modelSpec: "openai/gpt-4o-mini" }).find(
      (a) => a.path === "Dockerfile",
    )!.content;
    expect(dockerfile).not.toContain("FASTAGENT_MODEL");
  });

  it("bakes the agent directory as the definition, with a stable release, and says what a deployment keeps", () => {
    const dockerfiles = [input, { ...input, hasPackageJson: false }, { ...input, runtime: "bun" as const }].map(
      (i) => containerArtifacts(i).find((artifact) => artifact.path === "Dockerfile")!.content,
    );
    const values = dockerfiles.map((content) => /^ENV FASTAGENT_RELEASE_FILE=(\S+)$/m.exec(content)?.[1]);
    expect(values).toEqual(Array(3).fill("/app/definition/fastagent.release.json"));
    // Every image opens the baked definition by path; nothing selects an agent by name any more.
    for (const content of dockerfiles) {
      expect(content).toMatch(/^WORKDIR \/app\/definition$/m);
      expect(content).toMatch(/"start", "\/app\/definition"\]$/m);
      expect(content).not.toContain("FASTAGENT_AGENT");
    }
    const manifest = containerArtifacts(input).find((a) => a.path === "fastagent.release.json")!;
    expect(JSON.parse(manifest.content)).toEqual({ version: 1, id: "release-one", agent: "reviewer" });
    const before = process.env.FASTAGENT_RELEASE_FILE;
    const beforeAgentcore = process.env.FASTAGENT_AGENTCORE;
    try {
      delete process.env.FASTAGENT_RELEASE_FILE;
      delete process.env.FASTAGENT_AGENTCORE;
      const note = (tools: MountedTool[] = []) =>
        fastagentPromptSections({ tools, builtinExtensions: [] }).self_change ?? "";
      expect(note()).not.toContain("survives restarts");
      process.env.FASTAGENT_RELEASE_FILE = values[0];
      expect(note()).toContain("Your directory survives restarts");
      expect(note()).toContain("Each deployment replaces your directory with the author's release");
      // The agent's runtime path to a new capability is a skill + script, not a code reload — and that skill is
      // gone with the definition at the next deployment, which the same sentence has to say.
      expect(note()).toContain("To give yourself a new capability now, write a skill");
      expect(note()).toContain("It lasts until the next deployment replaces that directory");
      // `wake` is named only when it is mounted (a serve) — a tool the model lacks is one it would call.
      expect(note()).not.toContain("wake tool");
      expect(note([{ name: "wake" } as MountedTool])).toContain("use the wake tool.");
      // The host whose storage a deploy RESETS says so, rather than the release replacing only the directory.
      process.env.FASTAGENT_AGENTCORE = "1";
      expect(note()).not.toContain("Each deployment replaces your directory");
      expect(note()).toContain("resets this host's storage entirely");
      // Same path, same lifetime warning: this host's next deploy erases the definition along with the rest.
      expect(note()).toContain("To give yourself a new capability now, write a skill");
      expect(note()).toContain("It lasts until the next deployment replaces that directory");
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
