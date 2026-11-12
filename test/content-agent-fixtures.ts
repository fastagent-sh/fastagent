import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { modelsOver } from "../src/harnesses/models/models.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { runInProcess } from "./cli-run.ts";
import type { ResolvedContent } from "../src/content/resolve.ts";
import type { ContentEntry } from "../src/content/declare.ts";
import { assembleAgent, buildDefinition, loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";

/** Send one message to the agent in `agentDir`, opened on `provider` with `content`. */
export async function askOnce(
  agentDir: string,
  provider: Provider,
  content?: readonly ResolvedContent[],
): Promise<void> {
  const definition = await loadSourceDefinition(agentDir);
  const agent = await assembleAgent(definition, {
    storage: new MemoryStorage(),
    runsAs: NOT_HOSTED,
    processEnv: {},
    code: { ...buildDefinition(definition, {}), providers: [provider] },
    config: resolveConfig(definition),
    models: modelsOver(new InMemoryCredentialStore(), [provider]),
    model: "faux/faux-1",
    ...(content === undefined ? {} : { content }),
  });
  try {
    await agent.messages.send({ sessionId: (await agent.sessions.create()).id, content: "hi" }, { wait: 30 });
  } finally {
    await agent.close();
  }
}

async function skill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
}

/** The content the instance of the agent in `agentDir` adds, as `content add <dir>` writes it. */
export async function bind(agentDir: string, content: Record<string, ContentEntry>): Promise<void> {
  await writeFile(join(agentDir, "fastagent.json"), JSON.stringify({ content }));
}

/** An agent beside two projects: `app` it works on, `handbook` it knows. */
export async function layout() {
  // Real, because the CLI runs with this as its cwd and reports the spelling the process sees.
  const root = await realpath(await mkdtemp(join(tmpdir(), "fa-ctx-agent-")));
  const agentDir = join(root, "agent");
  const app = join(root, "app");
  const handbook = join(root, "handbook");
  for (const dir of [agentDir, app, handbook]) await mkdir(dir);
  await writeFile(join(agentDir, "AGENTS.md"), "OWN-AGENTS: how this agent is built and changed.\n");
  await writeFile(join(app, "AGENTS.md"), "APP-AGENTS: run the tests before committing.\n");
  await writeFile(join(handbook, "AGENTS.md"), "HANDBOOK-AGENTS: style rules.\n");
  await skill(join(app, ".pi", "skills", "release"), "release", "Cut a release of the app.");
  await skill(join(app, ".agents", "skills", "migrate"), "migrate", "Migrate the app's database.");
  await skill(join(agentDir, "skills", "deploy"), "deploy", "The agent's own deploy.");
  return { root, agentDir, app, handbook };
}

export const cli = (args: string[], cwd: string) => runInProcess(args, cwd);
