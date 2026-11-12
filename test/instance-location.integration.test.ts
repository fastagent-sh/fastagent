/**
 * Where an instance is, as a command's flags and the environment place it (agent-artifact.md §4.1): the resolvers'
 * precedence, and that each command that opens or reads an instance follows them. The merge of what the configuration
 * says is config.test.ts's.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, built, whileRunning } from "./cli-run.ts";

describe("commands that open an instance", () => {
  it("with no flags, start runs from .fastagent/start/, apart from dev's .fastagent/dev/", async () => {
    const dir = await agentWorkspace("fa-instance-default-start-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
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
});
