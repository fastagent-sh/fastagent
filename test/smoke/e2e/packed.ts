/**
 * The packages as a user gets them, end to end (AGENTS.md, "Tests"): the packed tarballs installed, an agent made
 * with `fastagent init`, asked a question with `fastagent invoke`, built with `fastagent build`, and the build opened
 * by an app through the package's own entry across both `pi-durable` and `dsh`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarballs = process.argv.slice(2).map((path) => resolve(path));
if (tarballs.length === 0) throw new Error("usage: node test/smoke/e2e/packed.ts <each tarball npm pack wrote>...");

const work = mkdtempSync(join(tmpdir(), "fa-e2e-"));
const env = { ...process.env, HOME: join(work, "home") };
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
sh("npm", ["install", "--no-audit", "--no-fund", ...tarballs], agent);
writeFileSync(
  join(agent, "fastagent.config.ts"),
  `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentConfig } from "@fastagent-sh/fastagent";

const faux = fauxProvider({ provider: "e2e", models: [{ id: "m" }] });
faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("pong")));

export default { model: "e2e/m", providers: [faux.provider] } satisfies AgentConfig;
`,
);
const fastagent = join(agent, "node_modules", ".bin", "fastagent");

expectEqual("invoke's answer", sh(fastagent, ["invoke", "ping", "--no-input"], agent).trim(), "pong");
expectEqual(
  "invoke's answer on harness: dsh",
  sh(fastagent, ["invoke", "ping", "--harness", "dsh", "--sandbox", "off", "--no-input"], agent).trim(),
  "pong",
);

sh(fastagent, ["build"], agent);

const app = join(agent, "app.mjs");
writeFileSync(
  app,
  `import { openAgent } from "@fastagent-sh/fastagent";
import definition from ${JSON.stringify(join(agent, "dist", "index.js"))};

const runOnce = async (opts) => {
  const instance = await openAgent(definition, opts);
  try {
    const { id } = await instance.sessions.create();
    const message = await instance.messages.send({ sessionId: id, content: "ping" }, { wait: 30 });
    return { status: message.status, text: message.answer?.text };
  } finally {
    await instance.close();
  }
};
const pi = await runOnce({ root: ${JSON.stringify(join(work, "instance"))} });
const dsh = await runOnce({ root: ${JSON.stringify(join(work, "instance"))}, harness: "dsh", sandbox: "off" });
console.log(JSON.stringify({ pi, dsh }));
`,
);
expectEqual("the build, opened by an app on both harnesses", JSON.parse(sh(process.execPath, [app], agent)), {
  pi: { status: "completed", text: "pong" },
  dsh: { status: "completed", text: "pong" },
});

console.error("end to end: the packed package installs, answers, builds, and its build answers in an app");
