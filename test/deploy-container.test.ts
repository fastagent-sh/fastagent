import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts } from "../src/deploy/container.ts";

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
});
