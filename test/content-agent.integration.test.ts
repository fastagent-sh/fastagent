import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDevProject } from "../src/harnesses/pi-durable/open.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { CODEX_MODEL } from "./codex-model.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";
import { bind, layout, cli } from "./content-agent-fixtures.ts";

describe("one resolution", () => {
  it("the opener, `info --json` and `content list --json` change together when the content does", async () => {
    // A second derivation of where the content is would disagree with this one sooner or later; here every
    // reader is asked after each change of the content.
    const { root, agentDir, app, handbook } = await layout();
    await writeFile(
      join(agentDir, "fastagent.config.ts"),
      `export default {\n  defaults: { model: "${CODEX_MODEL}" },\n};\n`,
    );
    await bind(agentDir, { app: { path: "../app" } });
    const readers = async () => {
      const { definition, instance } = await loadDevProject(agentDir);
      const opened = await openServing(definition, {
        secrets: {},
        env: {},
        ownEnv: process.env,
        runsAs: NOT_HOSTED,
        storage: "memory",
        ...(instance === undefined ? {} : { config: instance }),
      });
      await opened.agent.close();
      const info = JSON.parse((await cli(["info", "--json"], agentDir)).stdout);
      const list = JSON.parse((await cli(["content", "list", "--json"], agentDir)).stdout);
      return [opened.content, info.content, list.content];
    };
    const entry = (name: string, location: string) => ({
      name,
      kind: "local",
      location,
      notices: [],
    });
    const first = [entry("app", app)];
    expect(await readers()).toEqual([first, first, first]);

    const added = await cli(["content", "add", handbook, agentDir], root);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(`works on handbook  ${handbook} (a directory of this machine)`);
    const second = [...first, entry("handbook", handbook)];
    expect(await readers()).toEqual([second, second, second]);
    // The instance's file holds the paths, the one written by hand as it was; the program's file is not written.
    expect(JSON.parse(await readFile(join(agentDir, "fastagent.json"), "utf8"))).toEqual({
      content: { app: { path: "../app" }, handbook: { path: handbook } },
    });
    await expect(lstat(join(agentDir, "context.json"))).rejects.toThrow(/ENOENT/);

    const removed = await cli(["content", "remove", "APP", agentDir], root);
    expect(removed.code, removed.stderr).toBe(0);
    const third = [entry("handbook", handbook)];
    expect(await readers()).toEqual([third, third, third]);
    // The directory it named stays.
    expect((await lstat(app)).isDirectory()).toBe(true);

    // A directory that is gone is refused by every reader, naming it.
    await bind(agentDir, { gone: { path: join(root, "gone") } });
    const listed = await cli(["content", "list", "--json"], agentDir);
    expect([listed.code, listed.stderr]).toEqual([
      1,
      expect.stringContaining(`content "gone": ${join(root, "gone")} does not exist`),
    ]);
  });

  it("`content add` asks for a name it cannot take, and takes content around the agent", async () => {
    const { root, agentDir, app } = await layout();
    await writeFile(join(agentDir, "fastagent.config.ts"), `export default {};\n`);
    await bind(agentDir, { app: { path: app } });
    const before = await readFile(join(agentDir, "fastagent.json"), "utf8");
    const other = join(root, "elsewhere", "app");
    await mkdir(other, { recursive: true });
    const taken = await cli(["content", "add", other, agentDir], root);
    expect([taken.code, taken.stderr]).toEqual([
      2,
      expect.stringMatching(/already has content named "app" — pass --name/),
    ]);
    expect(await readFile(join(agentDir, "fastagent.json"), "utf8")).toBe(before);
    const missing = await cli(["content", "remove", "nope", agentDir], root);
    expect([missing.code, missing.stderr]).toEqual([
      2,
      expect.stringMatching(/no content named "nope" \(this agent has: app\)/),
    ]);
    // With a name of its own it is added.
    const named = await cli(["content", "add", other, agentDir, "--name", "app2"], root);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stderr).toContain(`works on app2  ${other} (a directory of this machine)`);
    expect(JSON.parse(await readFile(join(agentDir, "fastagent.json"), "utf8")).content).toEqual({
      app: { path: app },
      app2: { path: other },
    });
    const around = await cli(["content", "add", root, agentDir, "--name", "around"], root);
    expect(around.code, around.stderr).toBe(0);
  });
});
