/**
 * What `railway up` uploads (deploy/railway/ignore.ts): the generated `.railwayignore` keeps credentials and state home
 * and lets the deploy's own directory through `.gitignore`, and one the author kept is refused when it would not.
 * The patterns were verified against Railway itself (the same ones ripgrep reads); here is what the repository owns.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { railwayignore } from "../src/deploy/railway/ignore.ts";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

const GITIGNORE = ".fastagent\n.secrets\nnode_modules\n";

describe("deploy railway: what is uploaded", () => {
  it("the command writes it, keeps one it did not write, and stops --run on one that would lose the directory", async () => {
    const dir = await agentWorkspace("fa-railwayignore-cmd-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    await mkdir(join(dir, ".fastagent"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), GITIGNORE);
    const first = await runInProcess(["deploy", "railway", dir]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toContain("wrote .railwayignore");
    expect(await readFile(join(dir, ".railwayignore"), "utf8")).toBe(railwayignore());

    await writeFile(join(dir, ".railwayignore"), "tmp\n");
    const warned = await runInProcess(["deploy", "railway", dir]);
    expect(warned.code, warned.stderr).toBe(0);
    expect(warned.stderr).toMatch(/warn: your \.railwayignore \(kept\)/);
    expect(await readFile(join(dir, ".railwayignore"), "utf8")).toBe("tmp\n");
    const stopped = await runInProcess(["deploy", "railway", dir, "--run"]);
    expect(stopped.code, stopped.stderr).toBe(1);
    expect(stopped.stderr).toMatch(/deploy stopped: your \.railwayignore \(kept\)/);

    // One of ours that drifted is kept and reported until --force, which regenerates it; one that is not never is.
    await writeFile(join(dir, ".railwayignore"), `${railwayignore()}# drifted\n`);
    const kept = await runInProcess(["deploy", "railway", dir]);
    expect(kept.stderr).toMatch(/kept \.railwayignore — it no longer matches/);
    expect(await readFile(join(dir, ".railwayignore"), "utf8")).toContain("# drifted");
    const forced = await runInProcess(["deploy", "railway", dir, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await readFile(join(dir, ".railwayignore"), "utf8")).toBe(railwayignore());
    await writeFile(join(dir, ".railwayignore"), "tmp\n");
    await runInProcess(["deploy", "railway", dir, "--force"]);
    expect(await readFile(join(dir, ".railwayignore"), "utf8")).toBe("tmp\n");
  });
});
