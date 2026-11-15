import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { containerArtifacts } from "../../../src/deploy/container.ts";

const input = { name: "reviewer", runtime: "node", hasLockfile: true } as const;

describe("deploy/container: the portable image", () => {
  it("keeps tracked secrets scaffolds without shipping credentials, value files, state or clones", () => {
    const artifacts = containerArtifacts(input);
    const rootIgnore = artifacts.find((artifact) => artifact.path === ".dockerignore")!.content;

    // One ignore file serves both builders: a second one beside the Dockerfile would shadow an author's own.
    expect(artifacts.map((artifact) => artifact.path)).not.toContain("Dockerfile.dockerignore");
    expect(rootIgnore).not.toMatch(/^\*\*\/\.secrets$/m);

    // Excluding descendants rather than the directory keeps these negations meaningful in both
    // Docker's matcher and the stricter gitignore-style matcher the pre-flight uses.
    const ignored = ignore({ ignorecase: false }).add(rootIgnore);
    const ships = (path: string): boolean => !ignored.ignores(path);
    const tracked = ["README.md", ".secrets/.env.example", ".secrets/.gitignore"];
    const sensitive = [
      ".secrets/.env",
      ".secrets/auth.json",
      ".secrets/nested/token",
      ".env",
      ".env.production",
      // A value file a person named, which no `.env` rule reaches.
      "prod.env",
      ".state/sessions/session.jsonl",
      "content/app/README.md",
      ".state/channels/telegram.json",
      ".fastagent/dev/.state/agent.sqlite",
      ".fastagent/start/content/app/README.md",
    ];

    expect(tracked.filter((path) => !ships(path))).toEqual([]);
    expect(sensitive.filter(ships)).toEqual([]);
    expect(ships(".git/HEAD")).toBe(true);
  });

  it("marks the container as a deployed box that names its agent, and carries no instance value", () => {
    const dockerfile = containerArtifacts(input).find((artifact) => artifact.path === "Dockerfile")!.content;
    expect(dockerfile).toMatch(/^ENV FASTAGENT_DEPLOYED=1$/m);
    expect(dockerfile).toMatch(/^ENV FASTAGENT_NAME=reviewer$/m);
    expect(dockerfile).toMatch(/^ENV FASTAGENT_ROOT=\/data$/m);
    for (const name of ["FASTAGENT_CONFIG", "FASTAGENT_MODEL", "FASTAGENT_API_KEY"])
      expect(dockerfile).not.toContain(name);
  });
});
