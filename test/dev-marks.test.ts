import { afterEach, expect, it, vi } from "vitest";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";

// What `dev` does before it serves is the point here; entering an agent and supervising a worker are tested elsewhere.
const seenBySupervisor: (string | undefined)[] = [];
vi.mock("../src/cli/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/shared.ts")>()),
  enterAgentCommand: async () => ({ agentDir: "/agent", modelSpec: "faux/model" }),
}));
vi.mock("../src/dev-supervisor.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-supervisor.ts")>()),
  runDevSupervisor: async () => {
    seenBySupervisor.push(process.env[DEV_SERVE_ENV]);
  },
}));
const { runDev } = await import("../src/cli/commands/dev.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

it("dev marks the process before it spawns the worker that imports the channels, so the worker inherits it", async () => {
  vi.stubEnv(DEV_SERVE_ENV, "");
  vi.stubEnv("FASTAGENT_DEV_WORKER", "");
  await runDev("/agent", {});
  expect(seenBySupervisor).toEqual(["1"]);
});
