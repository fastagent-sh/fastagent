/**
 * `fastagent context add|list|fetch|remove`: the contexts the agent uses, as its context.json lists them and as they are
 * fetched into `.contexts/` (docs/design/agent-service.md §3.6).
 */
import { resolve } from "node:path";
import { isGithubRepo } from "../../content/declare.ts";
import { loadContent, loadContexts, loadEnvironment } from "../../content/file.ts";
import { type FetchedContext, fetchContexts, fetchedContexts } from "../../contexts/fetch.ts";
import { installPackages } from "../../environment/mise.ts";
import { ContextNameError, addContext, removeContext } from "../../harnesses/pi/authoring.ts";
import { log } from "../../log.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { enterAgentEnv } from "../../env.ts";
import { checkedMise } from "./env.ts";

/** A name refusal is the caller's to fix by naming another (exit 2); anything else is a startup failure (exit 1). */
function failEdit(hint: string) {
  return (error: unknown): never => {
    if (error instanceof ContextNameError) failUsage(`${error.message}${hint}`);
    failStartup(error);
  };
}

export async function runContextAdd(
  source: string,
  dirArg: string,
  opts: { name?: string; ref?: string },
): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(agentDir);
  const repo = source.startsWith("github:") ? source.slice("github:".length) : undefined;
  if (repo === undefined || !isGithubRepo(repo)) {
    failUsage(`${source} names no context: a context is a GitHub repository, written github:owner/repo`);
  }
  const name = opts.name ?? repo.slice(repo.indexOf("/") + 1);
  const added = await addContext(
    agentDir,
    { name, entry: { github: repo, ...(opts.ref !== undefined ? { ref: opts.ref } : {}) } },
    {
      // What the context brings is installed here first, as `fastagent env add` installs what it adds.
      install: async (environment, packages) => {
        if (packages.length === 0) return;
        await installPackages(
          agentDir,
          await checkedMise(agentDir, environment.packages),
          environment.packages,
          packages,
        );
      },
    },
  ).catch(failEdit(" — pass --name"));
  const context = added.contexts.find((one) => one.name === added.name) as FetchedContext;
  for (const line of contextLines([context])) console.error(`[fastagent] ${line}`);
  for (const note of added.notes) console.error(`[fastagent] ${note}`);
}

export async function runContextList(dirArg: string, json: boolean): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const contexts = await Promise.resolve()
    .then(() => fetchedContexts(agentDir, loadContexts(agentDir)))
    .catch(failStartup);
  if (json) {
    console.log(JSON.stringify(contexts, null, 2));
    return;
  }
  if (contexts.length === 0) console.log("(none: the agent uses no contexts)");
  for (const line of contextLines(contexts)) console.log(line);
}

/** Bring every context to its `ref` here, failing when one cannot be: what a host started by hand runs first. */
export async function runContextFetch(dirArg: string): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(agentDir);
  const fetched = await Promise.resolve()
    .then(async () => {
      const outcomes = await fetchContexts(agentDir, loadContexts(agentDir), "fail", true);
      // Fetching can succeed even when the new declarations conflict; surface that before claiming success.
      loadContent(agentDir);
      loadEnvironment(agentDir);
      return outcomes;
    })
    .catch(failStartup);
  for (const context of fetched) {
    const said = context.outcome === "fetched" ? "fetched" : "already up to date";
    console.error(`[fastagent] context ${context.name}: ${said} at ${context.commit.slice(0, 7)}`);
  }
  if (fetched.some((context) => context.outcome === "fetched")) {
    // Nothing that `dev` watches changes, so it does not restart: it runs on the contexts it opened with.
    log.info("[fastagent] a running `fastagent dev` keeps the contexts it started with until it restarts");
  }
}

export async function runContextRemove(name: string, dirArg: string): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const removed = await removeContext(agentDir, name).catch(failEdit(""));
  console.error(`[fastagent] removed context ${removed.name}`);
  for (const note of removed.notes) console.error(`[fastagent] ${note}`);
}

/** Each context's lines: where it is from and the commit fetched here, what it is for, and what it declares. */
function contextLines(contexts: readonly FetchedContext[]): string[] {
  const width = Math.max(0, ...contexts.map((context) => context.name.length));
  return contexts.flatMap((context) => {
    const from = `github ${context.repo}${context.ref ? `@${context.ref}` : ""}`;
    const at = context.commit ? `fetched at ${context.commit.slice(0, 7)}` : "not fetched here";
    const lines = [`${context.name.padEnd(width)}  ${from}, ${at}`];
    const indent = "".padEnd(width + 2);
    if (context.description) lines.push(`${indent}${context.description}`);
    if (context.error) lines.push(`${indent}⚠ ${context.error}`);
    const brings = context.brings;
    if (brings) {
      for (const [label, names] of [
        ["content", brings.content],
        ["packages", brings.packages],
        ["variables", brings.variables],
      ] as const) {
        if (names.length > 0) lines.push(`${indent}${label}: ${names.join(", ")}`);
      }
    }
    return lines;
  });
}
