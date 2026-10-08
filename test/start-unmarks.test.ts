import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";

// Where `start` enters the agent is the last point before any channel file is imported: record the mark there, stop.
const seenAtEntry: (string | undefined)[] = [];
const stopped = new Error("stopped at the agent's entry");
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  enterAgentCommand: async () => {
    seenAtEntry.push(process.env[DEV_SERVE_ENV]);
    throw stopped;
  },
}));
const { runStart } = await import("../src/cli/commands/start.ts");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("start is never dev, even run from a shell or tool a dev process spawned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-start-unmarks-"));
  vi.stubEnv(DEV_SERVE_ENV, "1");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw stopped;
  });
  await expect(runStart(dir, {})).rejects.toBe(stopped);
  expect(seenAtEntry).toEqual([undefined]);
  await rm(dir, { recursive: true, force: true });
});
