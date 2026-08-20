/**
 * A served agent behaves the same on the author's laptop and in a container.
 *
 * pi reads ITS settings (retry budget, compaction thresholds, default thinking level) from an agent
 * directory that defaults to the machine-global `~/.pi/agent`. Serving must not inherit the
 * operator's personal configuration: the artifact is the truth, not the box it runs on.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { piAgentSessionFactory } from "../src/engines/pi/agent-session-factory.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import { makeFaux } from "./faux.ts";

/** Bind one session with pi's settings taken from `agentDir`. */
async function bindWithSettings(agentDir: string) {
  const { faux } = makeFaux({ models: [{ id: "faux-thinker", reasoning: true }] });
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const cwd = process.cwd();
  const factory = piAgentSessionFactory({
    sessions: piInMemorySessionRecordStore({ cwd }),
    engine: async () => ({ modelRuntime, model: faux.getModel() }),
    systemPrompt: "test",
    cwd,
    agentDir,
    env: new NodeExecutionEnv({ cwd }),
  });
  return factory("s");
}

describe("pi settings are definition-scoped, not machine-global", () => {
  it("an operator's own pi configuration does not reach a served turn", async () => {
    // Nothing at the path the binding points at, so pi's own defaults apply. Were it still reading
    // ~/.pi/agent, this would report whatever the machine running the suite has configured — a
    // failure invisible on the author's laptop and only visible once deployed.
    const empty = await mkdtemp(join(tmpdir(), "fa-pi-nosettings-"));

    const session = await bindWithSettings(empty);

    expect(session.settingsManager.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: expect.any(Number),
      keepRecentTokens: expect.any(Number),
    });
    expect(session.settingsManager.getRetryEnabled()).toBe(true); // pi's default, not a local opt-out
  });

  it("reads the settings the DEPLOYMENT points at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-settings-"));
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ retry: { enabled: false }, compaction: { keepRecentTokens: 4321 } }),
    );

    const session = await bindWithSettings(dir);

    expect(session.settingsManager.getRetryEnabled()).toBe(false);
    expect(session.settingsManager.getCompactionSettings().keepRecentTokens).toBe(4321);
  });
});
