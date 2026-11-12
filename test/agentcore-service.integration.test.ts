import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPreparedStartService } from "../src/cli/commands/start.ts";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { agentDir } from "./agentcore-service-fixtures.ts";

describe("deferred AgentCore initialization", () => {
  it("the assemble stage REJECTS instead of exiting — every 503/probe verdict above depends on it", async () => {
    // On this host `openPreparedStartService` runs inside an envelope, so a `failStartup` there would
    // kill the container mid-request and the deploy driver would gate on a generic timeout instead of
    // the runtime's own error text.
    const dir = await agentDir({
      "src/channels/bad.mjs": "export default () => { throw new Error('broken channel'); };\n",
    });
    await buildProject(dir);
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit called");
    }) as never);
    try {
      await expect(openPreparedStartService(dir, { input: false })).rejects.toThrow(/broken channel/);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
    // The one test here that pays a full cold harness assembly: ~21s idle (measured), which the suite's
    // 30s ceiling never absorbed and 60s stopped absorbing too — a full `npm test` run puts a fork on
    // every core, and this stage is import-bound, so contention scales it by more than 3x. Raise the
    // budget rather than cap parallelism (vitest.config.ts states why). It still bounds a genuine hang:
    // every test here but this one and the IAM-door one below answers in ~10ms or less, so only those
    // two can spend it — they are the two that mount a service for real.
  }, 120_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a deployed box's build", () => {
  it("opens although the agent edited the project's copy, which only a local start refuses", async () => {
    const dir = await agentDir();
    await buildProject(dir);
    await writeFile(join(dir, "SYSTEM.md"), "The agent rewrote its own prompt.\n");
    await expect(openPreparedStartService(dir, { input: false })).rejects.toThrow(/built from other sources/);
    vi.stubEnv("FASTAGENT_DEPLOYED", "1");
    vi.stubEnv("FASTAGENT_STATE_DIR", join(dir, ".state"));
    const service = await openPreparedStartService(dir, { input: false });
    await service.close();
  }, 120_000);
});
