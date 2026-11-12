/**
 * The package as a user gets it, end to end (AGENTS.md, "Tests"): the packed tarball installed, an agent made
 * with `fastagent init`, asked a question with `fastagent invoke`, built with `fastagent build`, and the build opened by
 * an app through the package's own entry. The model is pi-ai's faux provider, so only npm's install leaves the machine.
 * Nothing here is aliased to src/. CI's packed-package job runs it: `node test/e2e/packed.ts <tarball>`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined) throw new Error("usage: node test/e2e/packed.ts <the tarball npm pack wrote>");

const work = mkdtempSync(join(tmpdir(), "fa-e2e-"));
// A machine of its own: no credentials, no model catalog fetched.
const env = { ...process.env, HOME: join(work, "home"), FASTAGENT_OFFLINE: "1" };
const sh = (command: string, args: string[], cwd: string): string => {
  console.error(`$ ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
};
const expectEqual = (what: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const tools = join(work, "tools");
sh("mkdir", ["-p", tools], work);
sh("npm", ["init", "-y"], tools);
sh("npm", ["install", "--no-audit", "--no-fund", tarball], tools);

const agent = join(work, "agent");
sh(join(tools, "node_modules", ".bin", "fastagent"), ["init", agent, "--no-install"], work);
// The agent's own dependencies as `init` declares them, but this build of fastagent instead of the registry's.
sh("npm", ["install", "--no-audit", "--no-fund", tarball], agent);
writeFileSync(
  join(agent, "fastagent.config.ts"),
  `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentConfig } from "@fastagent-sh/fastagent";

const faux = fauxProvider({ provider: "e2e", models: [{ id: "m" }] });
faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("pong")));

export default { defaults: { model: "e2e/m" }, providers: [faux.provider] } satisfies AgentConfig;
`,
);
const fastagent = join(agent, "node_modules", ".bin", "fastagent");

expectEqual("invoke's answer", sh(fastagent, ["invoke", "ping", "--no-input"], agent).trim(), "pong");

sh(fastagent, ["build"], agent);

// In the agent directory, where `@fastagent-sh/fastagent` is installed, as in an app that depends on it.
const app = join(agent, "app.mjs");
writeFileSync(
  app,
  `import { openAgent } from "@fastagent-sh/fastagent";
import definition from ${JSON.stringify(join(agent, "dist", "index.js"))};

const agent = await openAgent(definition, { root: ${JSON.stringify(join(work, "instance"))}, offline: true });
try {
  const { id } = await agent.sessions.create();
  const message = await agent.messages.send({ sessionId: id, content: "ping" }, { wait: 30 });
  console.log(JSON.stringify({ status: message.status, text: message.answer?.text }));
} finally {
  await agent.close();
}
`,
);
expectEqual("the build, opened by an app", JSON.parse(sh(process.execPath, [app], agent)), {
  status: "completed",
  text: "pong",
});

console.error("end to end: the packed package installs, answers, builds, and its build answers in an app");
