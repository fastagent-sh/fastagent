import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts, imageHasGit } from "../src/deploy/container.ts";
import { NOT_HOSTED, type RunsAs } from "../src/serving-command.ts";
import { definitionSections } from "../src/harnesses/pi-durable/text.ts";

const input = {
  runtime: "node",
  hasLockfile: true,
  agent: "reviewer",
  config: "{}",
} as const;

describe("deploy/container: shared Docker context", () => {
  it("keeps tracked secrets scaffolds without shipping credentials, state or clones", () => {
    const artifacts = containerArtifacts(input);
    const rootIgnore = artifacts.find((artifact) => artifact.path === ".dockerignore")!.content;

    // One ignore file serves both builders: a second one beside the Dockerfile would shadow an author's own.
    expect(artifacts.map((artifact) => artifact.path)).not.toContain("Dockerfile.dockerignore");
    expect(rootIgnore).toMatch(/^\*\*\/\.secrets\/\*\*$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.env\.example$/m);
    expect(rootIgnore).toMatch(/^!\*\*\/\.secrets\/\.gitignore$/m);
    expect(rootIgnore).not.toMatch(/^\*\*\/\.secrets$/m);
    // The local instances' state and clones, whichever environment's default root they are in.
    expect(rootIgnore).toMatch(/^\/\.fastagent$/m);

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
      ".fastagent/dev/.state/agent.sqlite",
      ".fastagent/start/content/app/README.md",
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
    // Empty without packages, so a list an earlier deploy wrote does not outlive the last package.
    expect(artifacts(input).find((a) => a.path === ".fastagent/deploy/fastagent.packages")?.content).toBe("");
    const packages = ["gh@2", "npm:@biomejs/biome@latest"];
    // The list is build output, one per line; the Dockerfile reads it, so a package change is no Dockerfile change.
    expect(
      artifacts({ ...input, packages }).find((a) => a.path === ".fastagent/deploy/fastagent.packages")?.content,
    ).toBe("gh@2\nnpm:@biomejs/biome@latest\n");
    expect(dockerfile({ ...input, packages })).toBe(dockerfile({ ...input, packages: ["jq@1"] }));
    // `start` opens dist/, which `railway up` leaves out as git-ignored: the image builds it, after the copy.
    for (const [runtime, build] of [
      ["node", "RUN ./node_modules/.bin/fastagent build"],
      ["bun", "RUN bun run fastagent build"],
    ] as const) {
      const text = dockerfile({ ...input, runtime });
      expect(text.indexOf("COPY . .")).toBeLessThan(text.indexOf(build));
      expect(text.indexOf(build)).toBeLessThan(text.indexOf("CMD ["));
    }
    for (const runtime of ["node", "bun"] as const) {
      const text = dockerfile({ ...input, runtime, packages });
      const order = ["RUN npm ci", "RUN bun install"].find((line) => text.includes(line)) as string;
      // Cached while the definition changes, and built again when the packages do.
      expect(text.indexOf(order)).toBeLessThan(
        text.indexOf("COPY .fastagent/deploy/fastagent.packages /tmp/fastagent.packages\nRUN export "),
      );
      expect(text.indexOf("COPY .fastagent/deploy/fastagent.packages /tmp/fastagent.packages")).toBeLessThan(
        text.indexOf("COPY . ."),
      );
      // In mise's system directory; the build's own mise directories are thrown away with the layer.
      expect(text).not.toContain("ENV MISE_DATA_DIR");
      expect(text).toContain("MISE_DATA_DIR=/tmp/mise ");
      expect(text).toContain(
        ` && xargs -d '\\n' -a /tmp/fastagent.packages "$MISE" install --system \\\n && rm -rf /tmp/mise\n`,
      );
      // The same isolation every run here has.
      expect(text).toContain(
        "MISE_GLOBAL_CONFIG_FILE=/dev/null/none.toml MISE_SYSTEM_CONFIG_FILE=/dev/null/none.toml " +
          "MISE_OVERRIDE_CONFIG_FILENAMES=/dev/null/none.toml MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES=/dev/null/none.toml " +
          "MISE_PYTHON_COMPILE=false",
      );
      expect(text).toContain(
        'MISE="/app/node_modules/@jdxcode/mise-linux-$(case "$(uname -m)" in aarch64|arm64) echo arm64;; *) echo x64;; esac)/bin/mise"',
      );
    }
  });

  it("has git when FastAgent installs it or the agent declares it in aptPackages, both in the apt layer", () => {
    expect(imageHasGit({ apt: ["git", "ca-certificates"] })).toBe(true);
    expect(imageHasGit({ apt: ["ca-certificates", "chromium"] })).toBe(false);
  });

  it("holds the program and nothing of an instance, so one build is every instance's image", () => {
    const files = (i: Parameters<typeof containerArtifacts>[0]) =>
      Object.fromEntries(containerArtifacts(i).map((a) => [a.path, a.content]));
    const one = files(input);
    const other = files({ ...input, agent: "support", config: '{"thinkingLevel":"high"}', configFile: "support.json" });
    // Every artifact is the same whichever instance it is for: a name, a configuration or a release changes none.
    expect(other).toEqual(one);
    // The only build output is the package list, which is the program's; no configuration, text or manifest.
    expect(Object.keys(one).sort()).toEqual([".dockerignore", ".fastagent/deploy/fastagent.packages", "Dockerfile"]);
    for (const text of Object.values(one)) {
      expect(text).not.toContain("/etc/fastagent");
      expect(text).not.toContain("FASTAGENT_CONFIG");
      expect(text).not.toContain("FASTAGENT_RELEASE");
      expect(text).not.toContain("FASTAGENT_MODEL");
    }
  });

  it("bakes the agent directory as the definition, and says what a deployment keeps", () => {
    const dockerfiles = [input, { ...input, hasPackageJson: false }, { ...input, runtime: "bun" as const }].map(
      (i) => containerArtifacts(i).find((artifact) => artifact.path === "Dockerfile")!.content,
    );
    // Every image opens the baked definition by path; nothing selects an agent by name any more.
    for (const content of dockerfiles) {
      expect(content).toMatch(/^WORKDIR \/app$/m);
      expect(content).toMatch(/"start", "\/app"\]$/m);
      expect(content).not.toContain("FASTAGENT_AGENT");
      // The root is one variable on the box, as everywhere else an instance is placed.
      expect(content).toMatch(/^ENV FASTAGENT_ROOT=\/data$/m);
      expect(content).not.toContain("STORAGE_DIR");
    }
    const note = (runsAs: RunsAs, wake = false) => {
      const section = definitionSections("/agent", [], { wake, runsAs }).find(({ key }) => key === "self_change");
      return (section?.render({} as never, {} as never) as string | undefined) ?? "";
    };
    const deployed: RunsAs = { dev: false, deployed: true, agentcore: false };
    expect(note(NOT_HOSTED)).not.toContain("survives restarts");
    expect(note(deployed)).toContain("Your directory survives restarts");
    // The directory is the host's storage, which a new release keeps; the definition is the image's.
    expect(note(deployed)).toContain("Your directory is this host's storage and survives deployments of a new version");
    // The definition is the release, read as built: the prompt must not invite an edit that is never read.
    expect(note(deployed)).toContain("is the author's release, read as it was built");
    expect(note(deployed)).not.toContain("write a skill");
    // `wake` is named only when it is mounted (a serve) — a tool the model lacks is one it would call.
    expect(note(deployed)).not.toContain("wake tool");
    expect(note(deployed, true)).toContain("use the wake tool.");
    // What the agent installs itself is the machine's.
    expect(note(deployed)).toContain("A tool you install yourself (apt-get, npm install -g) belongs to this machine");
    // The host whose storage a deploy RESETS says so, rather than the release replacing only the directory.
    const agentcore: RunsAs = { ...deployed, agentcore: true };
    expect(note(agentcore)).not.toContain("survives deployments of a new version");
    expect(note(agentcore)).toContain("resets this host's storage entirely");
    expect(note(agentcore)).toContain("is the author's release, read as it was built");
  });
});
