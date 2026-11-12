import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content/resolve.ts";
import { declareContent } from "../src/content/declare.ts";
import { loadDevProject } from "../src/harnesses/pi-durable/open.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";

/** The agent in `dir` as a serve opens it, with no storage of its own: what its content resolves to. */
export async function openedContent(dir: string, secrets: Record<string, string> = {}) {
  const { definition, instance } = await loadDevProject(dir);
  const opened = await openServing(definition, {
    secrets,
    env: {},
    ownEnv: process.env,
    runsAs: NOT_HOSTED,
    storage: "memory",
    ...(instance === undefined ? {} : { config: instance }),
  });
  await opened.agent.close();
  return opened.content;
}

export async function agent(): Promise<{ root: string; agentDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fa-ghctx-")));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  return { root, agentDir };
}

/** The github entry `entry` declares, named after its repository or `name`, resolved and narrowed. */
export function resolveOne(agentDir: string, { name, ...entry }: { github: string; ref?: string; name?: string }) {
  const key = name ?? (entry.github.split("/")[1] as string);
  const declared = declareContent({ [key]: entry }, { origin: "program", file: "context.json" });
  const [resolved] = resolveContent(declared, { workdir: agentDir });
  if (resolved?.kind !== "github") throw new Error("not github content");
  return resolved;
}
