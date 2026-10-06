/** `fastagent context list|add|remove`: what the agent works on and knows, as fastagent.config.ts declares it. */
import { resolve } from "node:path";
import { ContextNameError, addContext, listContexts, removeContext } from "../../engines/pi/authoring.ts";
import { type SourceOptions, declarationFor } from "../../contexts/source.ts";
import { contextLines } from "../contexts-view.ts";
import { failStartup, failUsage } from "../fail.ts";

/** A name refusal is the caller's to fix by naming another (exit 2); anything else is a startup failure (exit 1). */
export function failEdit(hint: string) {
  return (error: unknown): never => {
    if (error instanceof ContextNameError) failUsage(`${error.message}${hint}`);
    failStartup(error);
  };
}

export async function runContextList(dirArg: string, json: boolean): Promise<void> {
  const contexts = await listContexts(resolve(dirArg)).catch(failStartup);
  if (json) {
    console.log(JSON.stringify(contexts, null, 2));
    return;
  }
  for (const [label, value] of contextLines(contexts)) console.log(`${`${label}:`.padEnd(10)} ${value}`);
}

export async function runContextAdd(source: string, dirArg: string, opts: SourceOptions): Promise<void> {
  const { declaration, notes } = await Promise.resolve()
    .then(() => declarationFor(source, process.cwd(), opts))
    .catch(failStartup);
  for (const note of notes) console.error(`[fastagent] ${note}`);
  const { name, contexts } = await addContext(resolve(dirArg), declaration).catch(failEdit(" — pass --name"));
  const added = contexts.filter((context) => context.name === name);
  for (const [label, value] of contextLines(added)) console.error(`[fastagent] ${label} ${value}`);
}

export async function runContextRemove(name: string, dirArg: string): Promise<void> {
  const removed = await removeContext(resolve(dirArg), name).catch(failEdit(""));
  console.error(`[fastagent] removed context ${removed.name}`);
}
