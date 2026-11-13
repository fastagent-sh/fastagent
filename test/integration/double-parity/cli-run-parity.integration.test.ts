import { expect, it } from "vitest";
import { agentWorkspace, run, runInProcess } from "../../doubles/cli-run.ts";

// The in-process runner (runInProcess) is what most command-logic tests call instead of spawning the CLI. That is
// only sound while it answers what a process answers; this is the one place the two are put side by side.
it("runInProcess answers what a spawned CLI answers: exit code, stdout and stderr", async () => {
  const agent = await agentWorkspace("fa-parity-agent-");
  const cases: Array<{ args: string[]; cwd: string | undefined }> = [
    { args: ["--version"], cwd: undefined }, // exits 0 through commander
    { args: ["no-such-command"], cwd: agent }, // a parse error: exit 2, the unified `Error:` prefix on stderr
    { args: ["login"], cwd: agent }, // a refusal without a terminal: exit 2 and a usage line
    { args: ["login", "OpenAI", "--json"], cwd: agent }, // a structured answer on stdout with exit 2
    { args: ["login", "openai", "--method", "api-key", "--json"], cwd: agent }, // a structured answer, exit 0
  ];
  const env = { ...process.env, OPENAI_API_KEY: "" };
  const spawned = await Promise.all(cases.map(({ args, cwd }) => run(args, cwd, env))); // processes overlap; runs here do not
  for (const [i, { args, cwd }] of cases.entries()) {
    expect({ args, ...(await runInProcess(args, cwd, env)) }).toEqual({ args, ...spawned[i] });
  }
});

it("runInProcess puts back what it borrowed: cwd, environment, exit, and output", async () => {
  const before = { cwd: process.cwd(), env: { ...process.env }, exit: process.exit, write: process.stdout.write };
  const agent = await agentWorkspace("fa-parity-restore-");
  await runInProcess(["login"], agent, { PATH: process.env.PATH, ONLY_THIS: "1" });
  expect(process.cwd()).toBe(before.cwd);
  expect(process.env).toEqual(before.env);
  expect(process.exit).toBe(before.exit);
  expect(process.stdout.write).toBe(before.write);
  expect(process.exitCode).toBeUndefined();
});
