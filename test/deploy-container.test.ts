import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("keeps tracked secrets scaffolds without shipping credentials, state or clones", () => {
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
    ];

    // With .git shipped, this difference is the set `git ls-files --deleted` would report after COPY.
    expect(tracked.filter((path) => !ships(path))).toEqual([]);
    expect(sensitive.filter(ships)).toEqual([]);
    expect(ships(".git/HEAD")).toBe(true);
  });

  it("installs the environment after the dependencies and before the definition, with the agent's own mise", () => {
    const dockerfile = (i: Parameters<typeof containerArtifacts>[0]) =>
      containerArtifacts(i).find((artifact) => artifact.path === "Dockerfile")!.content;
    expect(dockerfile(input)).not.toMatch(/mise/);
    for (const runtime of ["node", "bun"] as const) {
      const text = dockerfile({ ...input, runtime, environment: { tools: ["jq"], packages: ["apt:chromium"] } });
      const order = ["RUN npm ci", "RUN bun install"].find((line) => text.includes(line)) as string;
      // Cached while the definition changes: the layers sit between the install and `COPY . .`.
      expect(text.indexOf(order)).toBeLessThan(text.indexOf("COPY mise.toml mise.lock ./"));
      expect(text.indexOf("COPY mise.toml mise.lock ./")).toBeLessThan(text.indexOf("COPY . ."));
      // The declared tools in mise's system directory; its data directory is the storage's at run time.
      expect(text).not.toContain("ENV MISE_DATA_DIR");
      expect(text).toContain("MISE_DATA_DIR=/tmp/mise ");
      expect(text).toMatch(/&& rm -rf \/tmp\/mise\n/);
      // The same isolation every run here has, for the directory the image holds the agent in.
      expect(text).toContain(
        "MISE_TRUSTED_CONFIG_PATHS=/app/definition/mise.toml MISE_CEILING_PATHS=/app MISE_GLOBAL_CONFIG_FILE=/dev/null/none.toml",
      );
      // System packages first, without apt's recommends (mise does not pass --no-install-recommends), then the lock.
      expect(text).toMatch(
        /APT::Install-Recommends "false";[\s\S]*"\$MISE" bootstrap packages apply --yes[\s\S]*"\$MISE" --locked install --system/,
      );
      expect(text).toContain(
        'MISE="node_modules/@jdxcode/mise-linux-$(case "$(uname -m)" in aarch64|arm64) echo arm64;; *) echo x64;; esac)/bin/mise"',
      );
    }
    // Each step only for what is declared: mise writes no lock without tools, so there is none to copy or install.
    const packagesOnly = dockerfile({ ...input, environment: { tools: [], packages: ["apt:chromium"] } });
    expect(packagesOnly).toContain("COPY mise.toml ./\n");
    expect(packagesOnly).toContain("bootstrap packages apply");
    expect(packagesOnly).not.toMatch(/mise\.lock|--locked install/);
    const toolsOnly = dockerfile({ ...input, environment: { tools: ["jq"], packages: [] } });
    expect(toolsOnly).toContain('"$MISE" --locked install --system');
    expect(toolsOnly).not.toMatch(/bootstrap|APT::/);
    expect(dockerfile({ ...input, environment: { tools: [], packages: [] } })).not.toMatch(/mise/);
  });

  it("has git when FastAgent installs it or the agent declares it in mise.toml", () => {
    expect(imageHasGit({ apt: ["git", "ca-certificates"] })).toBe(true);
    expect(imageHasGit({ apt: ["ca-certificates"], environment: { tools: [], packages: ["apt:git"] } })).toBe(true);
    expect(imageHasGit({ apt: ["ca-certificates"], environment: { tools: ["gh"], packages: ["apt:chromium"] } })).toBe(
      false,
    );
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
      // What the agent installs itself is the machine's; how it changes its declared tools, only when it has some.
      expect(note()).toContain("A tool you install yourself (apt-get, npm install -g) belongs to this machine");
      expect(note()).not.toContain("fastagent env use");
      const withEnvironment = (agentDir: string) =>
        fastagentPromptSections({ tools: [], builtinExtensions: [], workingSet: { agentDir, content: [] } })
          .self_change;
      const agentDir = mkdtempSync(join(tmpdir(), "fa-prompt-env-"));
      expect(withEnvironment(agentDir)).not.toContain("fastagent env use");
      writeFileSync(join(agentDir, "mise.toml"), `[tools]\njq = "1.8.1"\n`);
      expect(withEnvironment(agentDir)).toContain(
        "`./node_modules/.bin/fastagent env use <tool>@<version>` adds one, installs it and checks the change",
      );
      expect(withEnvironment(agentDir)).toContain("`./node_modules/.bin/fastagent env exec -- <command>`");
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
