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

it("what the agent runs from a dev process is not dev: the bash tool's children do not inherit the mark", async () => {
  const { piAllCodingTools } = await import("../src/engines/pi/create.ts");
  vi.stubEnv(DEV_SERVE_ENV, "1");
  const bash = piAllCodingTools(process.cwd()).find((tool) => tool.name === "bash");
  const result = (await bash?.execute("call-1", { command: `printf "[%s]" "$${DEV_SERVE_ENV}"` })) as {
    content: { type: string; text?: string }[];
  };
  expect(result.content.map((part) => part.text ?? "").join("")).toContain("[]");
  expect(process.env[DEV_SERVE_ENV]).toBe("1"); // the serving process itself keeps it
});
