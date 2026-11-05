/**
 * `fastagent content list|add|remove`: what the agent works on, as the program's `context.json` declares it and the
 * instance's configuration adds to it.
 */
import { resolve } from "node:path";
import { ContentNameError, addContent, listContent, removeContent } from "../../authoring.ts";
import { type SourceOptions, readContentSource } from "../../content/source.ts";
import { contentLines } from "../content-view.ts";
import { failStartup, failUsage } from "../fail.ts";
import { type InstanceFlags, enterContentScope } from "../instance.ts";

/** A name refusal is the caller's to fix by naming another (exit 2); anything else is a startup failure (exit 1). */
export function failEdit(hint: string) {
  return (error: unknown): never => {
    if (error instanceof ContentNameError) failUsage(`${error.message}${hint}`);
    failStartup(error);
  };
}

export async function runContentList(dirArg: string, json: boolean, flags?: InstanceFlags): Promise<void> {
  const dir = resolve(dirArg);
  const { content } = await listContent(dir, enterContentScope(dir, flags)).catch(failStartup);
  if (json) {
    console.log(JSON.stringify({ content }, null, 2));
    return;
  }
  for (const [label, value] of contentLines(content)) console.log(`${`${label}:`.padEnd(10)} ${value}`);
}

export async function runContentAdd(
  source: string,
  dirArg: string,
  opts: SourceOptions & { program?: boolean; instance?: InstanceFlags },
): Promise<void> {
  const dir = resolve(dirArg);
  const { program, instance, ...options } = opts;
  const { addition, notes } = await Promise.resolve()
    .then(() => readContentSource(source, process.cwd(), options))
    .catch(failStartup);
  for (const note of notes) console.error(`[fastagent] ${note}`);
  const scope = enterContentScope(dir, instance);
  const {
    name,
    content,
    notes: left,
  } = await addContent(dir, { ...addition, ...(program ? { program } : {}) }, scope).catch(failEdit(" — pass --name"));
  const added = content.filter((entry) => entry.name === name);
  for (const [label, value] of contentLines(added)) console.error(`[fastagent] ${label} ${value}`);
  for (const note of left) console.error(`[fastagent] ${note}`);
}

export async function runContentRemove(name: string, dirArg: string, flags?: InstanceFlags): Promise<void> {
  const dir = resolve(dirArg);
  const removed = await removeContent(dir, name, enterContentScope(dir, flags)).catch(failEdit(""));
  console.error(`[fastagent] removed content ${removed.name}`);
  for (const note of removed.notes) console.error(`[fastagent] ${note}`);
}
