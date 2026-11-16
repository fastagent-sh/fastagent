/**
 * Where an instance is, as a command's flags and the environment place it: the resolvers'
 * precedence, and that each command that opens or reads an instance follows them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateRoot } from "../../../packages/fastagent/src/paths.ts";
import { agentWorkspace, built, fauxAgent, run, whileRunning } from "../../doubles/cli-run.ts";

describe("commands that open an instance", () => {
  it("with no flags, start runs from .fastagent/start/, apart from dev's .fastagent/dev/", async () => {
    const dir = await agentWorkspace("fa-instance-default-start-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini" };\n`,
      ".secrets/production/.env": "OPENAI_API_KEY=sk-test\n",
    });
    await built(dir);
    await whileRunning(
      ["start", dir, "--port", "0", "--bind", "127.0.0.1", "--no-input"],
      /Agent API: .*\n/,
      async (stderr) => {
        expect(stderr).toContain(` — ${join(dir, ".fastagent", "start")}\n`);
        expect(stderr).toContain(`state:       ${join(dir, ".fastagent", "start", ".state")}`);
      },
    );
    expect(existsSync(join(dir, ".fastagent", "start", ".state", "agent.sqlite"))).toBe(true);
    expect(existsSync(join(dir, ".fastagent", "dev"))).toBe(false);
  });

  it("dev owns its instance: a command run beside it goes through its Agent API, and the claim is gone once it stops", async () => {
    const dir = await fauxAgent("fa-dev-owner-");
    const owner = join(resolveStateRoot(dir), "owner.json");
    await whileRunning(["dev", dir, "--no-watch", "--port", "0", "--no-input"], /Agent API: .*\n/, async (stderr) => {
      expect(stderr).toContain("for this machine's fastagent commands");
      expect(existsSync(owner)).toBe(true);
      const invoked = await run(["invoke", "hello", dir]);
      expect([invoked.code, invoked.stdout.trim()], invoked.stderr).toEqual([0, "seen 1"]);
      expect(invoked.stderr).toContain("through its serve at http://127.0.0.1:");
    });
    expect(existsSync(owner)).toBe(false);
  });
});
