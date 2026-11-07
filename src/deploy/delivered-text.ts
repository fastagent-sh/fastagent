/**
 * The instance text a deploy delivers (agent-artifact.md §6.1): the files and directories the delivered configuration
 * names, copied beside it into `fastagent.deploy/` with their layout, so the paths the configuration wrote, relative to
 * its file, resolve the same in the image's `/etc/fastagent/`. Only what is beside the configuration is delivered: a
 * path elsewhere on this machine does not exist on the host.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isUnderDir } from "../paths.ts";
import type { InstanceConfigSource } from "../harnesses/pi-durable/config.ts";
import { openText } from "../harnesses/pi-durable/text.ts";
import { type TextSource, declareText } from "../harnesses/pi-durable/text-sources.ts";
import { DELIVERED_CONFIG_DIR } from "./container.ts";

/** What the configuration names beyond the program's own text, each kind with its sources. */
function declared(agentDir: string, source: InstanceConfigSource): { kind: string; source: TextSource }[] {
  const text = declareText(agentDir, source);
  return (["instructions", "skills", "prompts"] as const).flatMap((kind) =>
    text[kind].filter((entry) => entry.declaredBy !== undefined).map((entry) => ({ kind, source: entry })),
  );
}

/** The first symbolic link under `root` that points at nothing, which `cp` would fail on after the person's steps. */
function danglingLink(root: string): string | undefined {
  if (!statSync(root).isDirectory()) return undefined;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink() && !existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Why the text `source` names cannot be delivered or would not open on the host, or undefined when it can and would:
 * the open's own refusals (a path of the wrong kind, a name taken twice), and a path that is not strictly inside the
 * configuration's directory, written relative to it, which the image could not reproduce.
 */
export function deliveredTextProblem(agentDir: string, source: InstanceConfigSource): string | undefined {
  try {
    openText(agentDir, source);
    for (const { kind, source: entry } of declared(agentDir, source)) {
      const at = `${source.label}: ${kind} "${entry.given}"`;
      const { directory } = source;
      const given = entry.given ?? "";
      if (directory === undefined || isAbsolute(given) || given === "~" || given.startsWith("~/")) {
        return `${at} is not relative to the configuration: a deploy delivers what is beside it, so write a relative path`;
      }
      if (!isUnderDir(entry.path, directory) || entry.path === directory) {
        return `${at} is outside the configuration's directory (${directory}): a deploy delivers only what is inside it`;
      }
      if (isUnderDir(agentDir, entry.path)) {
        return `${at} contains the agent directory ${agentDir}: it cannot be delivered into it`;
      }
      const dangling = danglingLink(entry.path);
      if (dangling !== undefined) return `${at} holds a symbolic link to nothing: ${dangling}`;
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Replace `fastagent.deploy/` in `agentDir` with the text `source` names, whole: what an earlier deploy delivered and
 * this one does not is gone, as the release manifest and the configuration are rewritten. The configuration's own file
 * is written after, with the other build outputs. Answers how many paths were copied.
 */
export async function deliverText(agentDir: string, source: InstanceConfigSource | undefined): Promise<number> {
  // Copying is an act, not a finding: whatever the pre-flight only warned about (a generate-only run) must not be
  // carried out, or a path outside the configuration's directory would be written outside `fastagent.deploy/`.
  const problem = source === undefined ? undefined : deliveredTextProblem(agentDir, source);
  if (problem !== undefined) throw new Error(problem);
  const target = join(agentDir, DELIVERED_CONFIG_DIR);
  if (source?.directory !== undefined && isUnderDir(source.directory, target)) {
    throw new Error(
      `${source.label} is inside ${target}, which every deploy replaces: keep the configuration elsewhere`,
    );
  }
  await rm(target, { recursive: true, force: true });
  if (source?.directory === undefined) return 0;
  const entries = declared(agentDir, source);
  for (const { source: entry } of entries) {
    const to = join(target, relative(source.directory, entry.path));
    await mkdir(dirname(to), { recursive: true });
    await cp(entry.path, to, { recursive: true, dereference: true });
  }
  return entries.length;
}
