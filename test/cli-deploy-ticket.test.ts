/**
 * `deploy <host> --run --json`, for a coding agent: the deploy runs as a ticket's step, which has someone to hand the
 * person's parts to. The command that starts it and the step are each tested here, in this process; that a step outlives
 * the command that starts it is `startTicket`'s (ticket.integration.test.ts), and a step that runs a host CLI's own
 * sign-in is cli-deploy.integration.test.ts's, since that sign-in is a process of the host CLI's.
 */
import { afterEach, expect, it, vi } from "vitest";
import { checkTicket, createTicket } from "../src/cli/ticket.ts";
import { agentWorkspace, runInProcess } from "./cli-run.ts";
import { CODEX_MODEL } from "./codex-model.ts";
import { fakeAwsAndDocker } from "./cli-deploy-fixtures.ts";
import { resetHostClis } from "./host-cli-double.ts";

vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"));
vi.mock("../src/git.ts", () => import("./git-double.ts"));
vi.mock("../src/deploy/runner.ts", () => import("./host-cli-double.ts"));

/** What the command asked `startTicket` to start: the step's own process is run by hand below. */
const started: unknown[] = [];
vi.mock("../src/cli/ticket.ts", async (original) => {
  const real = await original<typeof import("../src/cli/ticket.ts")>();
  return {
    ...real,
    startTicket: async (input: Parameters<typeof real.startTicket>[0]) => {
      started.push(input);
      return { ...real.createTicket(input), status: "working" as const };
    },
  };
});

afterEach(() => {
  started.splice(0);
  resetHostClis();
});

const agent = () =>
  agentWorkspace("fa-deploy-ac-ticket-", {
    "fastagent.config.ts": `export default { defaults: { model: "${CODEX_MODEL}" } };\n`,
  });

it("deploy agentcore --run --json asks for a ticket that runs the same deploy, joining one already running", async () => {
  const dir = await agent();
  const result = await runInProcess(["deploy", "agentcore", dir, "--run", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const [asked] = started as [Record<string, unknown> & { command: { args: string[] } }];
  expect(asked).toMatchObject({
    subject: `deploy:agentcore:${dir}`,
    fields: { deployment: "agentcore" },
    action: "deploy the agent to agentcore",
    waitsFirst: false,
    // A deploy stopped halfway leaves the host half-changed.
    whenRunning: "join",
  });
  expect(asked.command.args.slice(-5)).toEqual(["deploy", "agentcore", dir, "--run", "--json"]);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "working", deployment: "agentcore" });
});

it("the step goes on past the login a deploy wipes, since it has someone to redo it", async () => {
  const dir = await agent();
  // The target holds no model key: the login on the box is what the model has, and this deploy wipes it.
  const aws = fakeAwsAndDocker("{}");
  const { ticket } = createTicket({
    subject: `deploy:agentcore:${dir}`,
    action: "deploy the agent to agentcore",
    check: "fastagent deploy agentcore --check",
    restart: `fastagent deploy agentcore ${dir} --run`,
    timeoutSeconds: 60,
    fields: { deployment: "agentcore" },
  });
  await runInProcess(["deploy", "agentcore", dir, "--run", "--json", "--ticket", ticket]);
  // Past the stop a deploy with nobody to redo the login makes: on to the image, whose docker the fake refuses.
  const ended = await checkTicket(ticket);
  expect(ended?.status).toBe("failed");
  expect(ended?.message).not.toContain("wipes the runtime");
  expect(aws.calls()).toContain("ecr describe-repositories");
});
