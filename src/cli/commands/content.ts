/** `fastagent content list|add|remove`: what the agent works on and knows, as `context.json` declares it. */
import { resolve } from "node:path";
import { ContentNameError, addContent, listContent, removeContent } from "../../harnesses/pi/authoring.ts";
import { type SourceOptions, readContentSource } from "../../content/source.ts";
import { contentLines } from "../content-view.ts";
import { failStartup, failUsage } from "../fail.ts";

/** A name refusal is the caller's to fix by naming another (exit 2); anything else is a startup failure (exit 1). */
export function failEdit(hint: string) {
  return (error: unknown): never => {
    if (error instanceof ContentNameError) failUsage(`${error.message}${hint}`);
    failStartup(error);
  };
}

export async function runContentList(dirArg: string, json: boolean): Promise<void> {
  const content = await listContent(resolve(dirArg)).catch(failStartup);
  if (json) {
    console.log(JSON.stringify(content, null, 2));
    return;
  }
  for (const [label, value] of contentLines(content)) console.log(`${`${label}:`.padEnd(10)} ${value}`);
}

export async function runContentAdd(source: string, dirArg: string, opts: SourceOptions): Promise<void> {
  const { addition, notes } = await Promise.resolve()
    .then(() => readContentSource(source, process.cwd(), opts))
    .catch(failStartup);
  for (const note of notes) console.error(`[fastagent] ${note}`);
  const { name, content } = await addContent(resolve(dirArg), addition).catch(failEdit(" — pass --name"));
  const added = content.filter((entry) => entry.name === name);
  for (const [label, value] of contentLines(added)) console.error(`[fastagent] ${label} ${value}`);
}

export async function runContentRemove(name: string, dirArg: string): Promise<void> {
  const removed = await removeContent(resolve(dirArg), name).catch(failEdit(""));
  console.error(`[fastagent] removed content ${removed.name}`);
  for (const note of removed.notes) console.error(`[fastagent] ${note}`);
}
