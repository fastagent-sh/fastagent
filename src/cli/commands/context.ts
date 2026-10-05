/** `fastagent context list|add|remove`: what the agent works on and knows, as fastagent.config.ts declares it. */
import { basename, resolve } from "node:path";
import { loadConfig, writeContexts } from "../../engines/pi/config.ts";
import { type ContextDeclaration, declarationFor, declareContexts, isContextName } from "../../contexts/declare.ts";
import { resolveContexts } from "../../contexts/resolve.ts";
import { contextLines } from "../contexts-view.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { makeWorkingDirectory } from "../workdir.ts";

/** The agent's declarations as written (not resolved: a command rewrites what the author wrote). */
async function declared(agentDir: string): Promise<ContextDeclaration[]> {
  const { config } = await loadConfig(agentDir).catch(failStartup);
  return config.contexts ?? [];
}

export async function runContextList(dirArg: string, json: boolean): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const declarations = await declared(agentDir);
  const contexts = await Promise.resolve()
    .then(() => resolveContexts(agentDir, declarations))
    .catch(failStartup);
  if (json) {
    console.log(JSON.stringify(contexts, null, 2));
    return;
  }
  for (const [label, value] of contextLines(contexts)) console.log(`${`${label}:`.padEnd(10)} ${value}`);
}

export async function runContextAdd(
  source: string,
  dirArg: string,
  opts: { copy?: boolean; readonly?: boolean; workdir?: boolean; name?: string },
): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const declarations = await declared(agentDir);
  const added = await Promise.resolve()
    .then(() => declarationFor(source, process.cwd(), opts))
    .catch(failStartup);
  // The default name is the directory's; asked for explicitly when it cannot be one, or is taken.
  const name = opts.name ?? basename((added as { local: string }).local);
  if (!isContextName(name)) {
    failUsage(`"${name}" cannot name a context (one path segment of letters, digits, "-" and "_") — pass --name`);
  }
  const taken = declareContexts(declarations, agentDir).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (taken) failUsage(`this agent already has a context named "${taken.name}" — pass --name`);
  const next = [...declarations, added];
  // Checked before anything is made: a working directory that does not exist yet is checked as the path it will have,
  // and a refusal (a second working directory, a nested one) leaves nothing behind.
  const toCreate = opts.workdir ? (added as { local: string }).local : undefined;
  await Promise.resolve()
    .then(() => resolveContexts(agentDir, next, toCreate ? { toCreate } : {}))
    .catch(failStartup);
  const made = toCreate ? await makeWorkingDirectory(toCreate).catch(failStartup) : undefined;
  await writeContexts(agentDir, next).catch(async (error: unknown) => {
    await made?.undo();
    failStartup(error);
  });
  if (made?.created) console.error(`[fastagent] created ${toCreate}`);
  const [context] = resolveContexts(agentDir, [added]);
  for (const [label, value] of contextLines(context ? [context] : [])) console.error(`[fastagent] ${label} ${value}`);
}

export async function runContextRemove(name: string, dirArg: string): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const declarations = await declared(agentDir);
  const names = declareContexts(declarations, agentDir).map((c) => c.name);
  const index = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  if (index === -1) {
    failUsage(`no context named "${name}" (this agent has: ${names.join(", ") || "none"})`);
  }
  await writeContexts(
    agentDir,
    declarations.filter((_, i) => i !== index),
  ).catch(failStartup);
  console.error(`[fastagent] removed context ${names[index]}`);
}
