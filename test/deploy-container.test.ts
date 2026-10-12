import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts, imageHasGit } from "../src/deploy/container.ts";
import { fastagentPromptSections } from "../src/harnesses/pi/create.ts";
import type { MountedTool } from "../src/harnesses/pi/tool.ts";

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
  it("keeps tracked secrets scaffolds without shipping credentials, state, clones or this machine's bindings", () => {
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
      "content/app/README.md",
      "content/notes",
      ".state/channels/telegram.json",
      "context.local.json",
    ];

    // With .git shipped, this difference is the set `git ls-files --deleted` would report after COPY.
    expect(tracked.filter((path) => !ships(path))).toEqual([]);
    expect(sensitive.filter(ships)).toEqual([]);
    expect(ships(".git/HEAD")).toBe(true);
  });

  it("installs the packages deploy lists after the dependencies and before the definition", () => {
    const artifacts = (i: Parameters<typeof containerArtifacts>[0]) => containerArtifacts(i);
    const dockerfile = (i: Parameters<typeof containerArtifacts>[0]) =>
      artifacts(i).find((artifact) => artifact.path === "Dockerfile")!.content;
    expect(dockerfile(input)).not.toMatch(/mise/);
    expect(artifacts(input).map((a) => a.path)).not.toContain("fastagent.packages");
    const packages = ["gh@2", "npm:@biomejs/biome@latest"];
    // The list is build output, one per line; the Dockerfile reads it, so a package change is no Dockerfile change.
    expect(artifacts({ ...input, packages }).find((a) => a.path === "fastagent.packages")?.content).toBe(
      "gh@2\nnpm:@biomejs/biome@latest\n",
    );
    expect(dockerfile({ ...input, packages })).toBe(dockerfile({ ...input, packages: ["jq@1"] }));
    for (const runtime of ["node", "bun"] as const) {
      const text = dockerfile({ ...input, runtime, packages });
      const order = ["RUN npm ci", "RUN bun install"].find((line) => text.includes(line)) as string;
      // Cached while the definition changes, and built again when the packages do.
      expect(text.indexOf(order)).toBeLessThan(text.indexOf("COPY fastagent.packages ./\nRUN export "));
      expect(text.indexOf("COPY fastagent.packages ./")).toBeLessThan(text.indexOf("COPY . ."));
      // In mise's system directory; the build's own mise directories are thrown away with the layer.
      expect(text).not.toContain("ENV MISE_DATA_DIR");
      expect(text).toContain("MISE_DATA_DIR=/tmp/mise ");
      expect(text).toContain(
        ` && xargs -d '\\n' -a fastagent.packages "$MISE" install --system \\\n && rm -rf /tmp/mise\n`,
      );
      // The same isolation every run here has.
      expect(text).toContain(
        "MISE_GLOBAL_CONFIG_FILE=/dev/null/none.toml MISE_SYSTEM_CONFIG_FILE=/dev/null/none.toml " +
          "MISE_OVERRIDE_CONFIG_FILENAMES=/dev/null/none.toml MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES=/dev/null/none.toml " +
          "MISE_PYTHON_COMPILE=false",
      );
      expect(text).toContain(
        'MISE="/app/definition/node_modules/@jdxcode/mise-linux-$(case "$(uname -m)" in aarch64|arm64) echo arm64;; *) echo x64;; esac)/bin/mise"',
      );
    }
  });

  it("has git when FastAgent installs it or the agent declares it in aptPackages, both in the apt layer", () => {
    expect(imageHasGit({ apt: ["git", "ca-certificates"] })).toBe(true);
    expect(imageHasGit({ apt: ["ca-certificates", "chromium"] })).toBe(false);
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
      expect(note()).toContain("Either lasts until the next deployment replaces that directory");
      expect(note()).toContain("a pi extension in extensions/, loaded from your next session on");
      // `wake` is named only when it is mounted (a serve) — a tool the model lacks is one it would call.
      expect(note()).not.toContain("wake tool");
      expect(note([{ name: "wake" } as MountedTool])).toContain("use the wake tool.");
      // What the agent installs itself is the machine's.
      expect(note()).toContain("A tool you install yourself (apt-get, npm install -g) belongs to this machine");
      // The host whose storage a deploy RESETS says so, rather than the release replacing only the directory.
      process.env.FASTAGENT_AGENTCORE = "1";
      expect(note()).not.toContain("Each deployment replaces your directory");
      expect(note()).toContain("resets this host's storage entirely");
      // Same path, same lifetime warning: this host's next deploy erases the definition along with the rest.
      expect(note()).toContain("To give yourself a new capability now, write a skill");
      expect(note()).toContain("Either lasts until the next deployment replaces that directory");
      expect(note()).toContain("a pi extension in extensions/, loaded from your next session on");
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
