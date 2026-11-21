/**
 * The packages as a user gets them, end to end (AGENTS.md, "Tests"): the packed tarballs installed, an agent made
 * with `fastagent init`, asked a question with `fastagent invoke`, built with `fastagent build`, an extension's command
 * run through it (`fastagent agentcore`), and the build opened by an app through the package's own entry. The model is pi-ai's faux provider, so only npm's install leaves the machine.
 * Nothing here is aliased to src/. CI's packed-package job runs it: `node test/smoke/e2e/packed.ts <tarball>...`, every
 * package's, since one package depends on another's version before it is published.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarballs = process.argv.slice(2).map((path) => resolve(path));
if (tarballs.length === 0) throw new Error("usage: node test/smoke/e2e/packed.ts <each tarball npm pack wrote>...");

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
sh("npm", ["install", "--no-audit", "--no-fund", ...tarballs], tools);

const agent = join(work, "agent");
sh(join(tools, "node_modules", ".bin", "fastagent"), ["init", agent, "--no-install"], work);
// The agent's own dependencies as `init` declares them, but this build of fastagent instead of the registry's.
sh("npm", ["install", "--no-audit", "--no-fund", ...tarballs], agent);
writeFileSync(
  join(agent, "fastagent.config.ts"),
  `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentConfig } from "@fastagent-sh/fastagent";

const faux = fauxProvider({ provider: "e2e", models: [{ id: "m" }] });
faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("pong")));

export default { model: "e2e/m", providers: [faux.provider] } satisfies AgentConfig;
`,
);
const fastagent = join(agent, "node_modules", ".bin", "fastagent");

expectEqual("invoke's answer", sh(fastagent, ["invoke", "ping", "--no-input"], agent).trim(), "pong");

sh(fastagent, ["build"], agent);
// An installed extension's command, through the agent's own CLI (resolved from `-C` outside the agent dir).
expectEqual(
  "fastagent agentcore's usage",
  sh(join(tools, "node_modules", ".bin", "fastagent"), ["-C", agent, "agentcore", "--help"], work).split("\n")[0],
  "Usage: fastagent [-C <dir>] agentcore <command>",
);
// Production installs of `@fastagent-sh/agentcore` omit `@aws-sdk/client-bedrock-agentcore`; invoking without it exits 2 naming it.
const missingSdk = spawnSync(
  fastagent,
  ["agentcore", "invoke", "ping", "--arn", "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/demo"],
  { cwd: agent, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
expectEqual("agentcore invoke without aws sdk exits 2", missingSdk.status, 2);
if (!missingSdk.stderr.includes("npm install @aws-sdk/client-bedrock-agentcore")) {
  throw new Error(`expected install hint in stderr, got: ${missingSdk.stderr}`);
}

// In the agent directory, where `@fastagent-sh/fastagent` is installed, as in an app that depends on it.
const app = join(agent, "app.mjs");
writeFileSync(
  app,
  `import { openAgent } from "@fastagent-sh/fastagent";
import definition from ${JSON.stringify(join(agent, "dist", "index.js"))};

const agent = await openAgent(definition, { root: ${JSON.stringify(join(work, "instance"))} });
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
