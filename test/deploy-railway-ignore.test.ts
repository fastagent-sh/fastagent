/**
 * What `railway up` uploads (deploy/railway/ignore.ts): the generated `.railwayignore` keeps credentials and state home
 * and lets the deploy's own directory through `.gitignore`, and one the author kept is refused when it would not.
 * The patterns were verified against Railway itself (the same ones ripgrep reads); here is what the repository owns.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { keptRailwayignoreProblem, railwayignore } from "../src/deploy/railway/ignore.ts";
import { agentWorkspace } from "./cli-run.ts";

const GITIGNORE = ".fastagent\n.secrets\nnode_modules\n";

describe("deploy railway: what is uploaded", () => {
  it("the generated file leaves the deploy's directory in and credentials, state and the dev instance out", () => {
    const upload = ignore().add(GITIGNORE).add(railwayignore());
    expect(upload.ignores(".fastagent/deploy/fastagent.json")).toBe(false);
    expect(upload.ignores(".fastagent/deploy/extra-skills/audit/SKILL.md")).toBe(false);
    for (const path of [
      ".fastagent/dev/state.db",
      ".fastagent/start/x",
      ".secrets/.env",
      ".secrets/production/.env",
      ".env",
      ".env.local",
      ".state/agent.sqlite",
      "content/app/x",
    ]) {
      expect(upload.ignores(path), path).toBe(true);
    }
    expect(upload.ignores(".env.example")).toBe(false);
    expect(upload.ignores("src/tools/x.ts")).toBe(false);
    // Outside a git repository `.gitignore` is not applied at all, and the file alone keeps the credentials home.
    const alone = ignore().add(railwayignore());
    for (const path of [".secrets/.env", ".secrets/auth.json", ".env", ".state/agent.sqlite", "content/app/x"]) {
      expect(alone.ignores(path), path).toBe(true);
    }
  });

  it("excludes a value file in the agent directory by its path, since no name rule reaches `prod.env`", async () => {
    const generated = ignore().add(railwayignore(["prod.env", ".secrets", "deep/dir/keys.txt"]));
    for (const path of ["prod.env", "deep/dir/keys.txt"]) expect(generated.ignores(path), path).toBe(true);
    expect(generated.ignores("other.env")).toBe(false);
    // Without one named, the file is the one it always was.
    expect(railwayignore()).toBe(railwayignore([".secrets", ".state/x"]));
    expect(railwayignore()).not.toContain("prod.env");

    // A kept file that does not exclude it is refused, naming it and the line to add; one that does, or a generated one, is not.
    const dir = await agentWorkspace("fa-railwayignore-valuefile-", {});
    await writeFile(join(dir, ".railwayignore"), "tmp\n");
    expect(keptRailwayignoreProblem(dir, ["prod.env", ".secrets"])).toMatch(
      /does not exclude `prod\.env`.*it holds secrets\. Add `\/prod\.env`/,
    );
    await writeFile(join(dir, ".railwayignore"), "/prod.env\n");
    expect(keptRailwayignoreProblem(dir, ["prod.env", ".secrets"])).toBeUndefined();
    await writeFile(join(dir, ".railwayignore"), railwayignore(["prod.env"]));
    expect(keptRailwayignoreProblem(dir, ["prod.env"])).toBeUndefined();
  });

  it("is refused when the author kept a .railwayignore that, with .gitignore, drops the deploy's directory", async () => {
    const dir = await agentWorkspace("fa-railwayignore-", {});
    const problem = () => keptRailwayignoreProblem(dir);
    expect(problem()).toBeUndefined();
    await writeFile(join(dir, ".gitignore"), GITIGNORE);
    await writeFile(join(dir, ".railwayignore"), railwayignore());
    expect(problem()).toBeUndefined();
    await writeFile(join(dir, ".railwayignore"), "tmp\n");
    expect(problem()).toMatch(/your \.railwayignore \(kept\), with \.gitignore, leaves \.fastagent\/deploy\/ out/);
    await writeFile(join(dir, ".railwayignore"), "!.fastagent\n.fastagent/*\n!.fastagent/deploy\n");
    expect(problem()).toBeUndefined();
    // Nothing in .gitignore drops it: the author's file is theirs.
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    await writeFile(join(dir, ".railwayignore"), "tmp\n");
    expect(problem()).toBeUndefined();
  });
});
