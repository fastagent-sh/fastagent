/**
 * Fetch contexts into .contexts/<name>, validating a fresh snapshot before replacing the copy. Development can use a
 * cached copy when its remote is unreachable; add, fetch and deploy cannot. Production only reads copies.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { cloneSnapshot } from "../content/git.ts";
import { loadContexts, parseContextCopy } from "../content/file.ts";
import { log } from "../log.ts";
import { CONTEXT_FILE, contextCopyPath } from "../paths.ts";
import { COPY_RECORD, copyRecord, readCopyRecord } from "./copy.ts";
import { writeFileAtomic } from "../atomic-write.ts";
import { type DeclaredContext, contextSource, declareContexts } from "./declare.ts";

export type ContextFetch = { name: string; commit: string } & (
  | { outcome: "fetched" | "current" }
  | { outcome: "kept"; reason: string }
);

/** The lock is transient process coordination, not a version lock: fetch and remove must not replace each other's copy. */
export async function withContextCopy<T>(agentDir: string, name: string, use: () => Promise<T>): Promise<T> {
  const dir = contextCopyPath(agentDir, name);
  const root = dirname(dir);
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${root} is a link: contexts must be fetched inside the agent directory`);
  }
  mkdirSync(root, { recursive: true });
  const release = await lockfile.lock(dir, {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000 },
  });
  try {
    return await use();
  } finally {
    await release();
  }
}

export async function fetchContexts(
  agentDir: string,
  contexts: readonly DeclaredContext[],
  onFailure: "keep" | "fail",
  requireListed = false,
): Promise<ContextFetch[]> {
  // Public callers do not necessarily come through the file parser; a name becomes a path before git runs.
  const checked = declareContexts(
    Object.fromEntries(contexts.map((context) => [context.name, { github: context.repo, ref: context.ref }])),
  );
  const outcomes = await Promise.allSettled(
    checked.map((context) =>
      withContextCopy(agentDir, context.name, () => {
        if (
          requireListed &&
          !loadContexts(agentDir).some(
            (one) => one.name === context.name && one.repo === context.repo && one.ref === context.ref,
          )
        ) {
          throw new Error(`context "${context.name}" is no longer declared at that repository and ref`);
        }
        return fetchOne(agentDir, context, onFailure);
      }),
    ),
  );
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<ContextFetch>).value);
}

async function fetchOne(agentDir: string, context: DeclaredContext, onFailure: "keep" | "fail"): Promise<ContextFetch> {
  const { name, repo, ref } = context;
  const dir = contextCopyPath(agentDir, name);
  const found = lstatSync(dir, { throwIfNoEntry: false });
  if (found && (!found.isDirectory() || !existsSync(join(dir, COPY_RECORD)))) {
    throw new Error(`${dir} is not a fetched context copy: move it away before fetching`);
  }
  const next = mkdtempSync(join(dirname(dir), `.${name}.next-`));
  try {
    let commit: string;
    try {
      commit = await cloneSnapshot(repo, ref, next);
    } catch (error) {
      if (onFailure === "keep" && found) {
        const had = copyRecord(agentDir, context);
        return { name, commit: had.commit, outcome: "kept", reason: (error as Error).message };
      }
      throw new Error(`context "${name}": ${(error as Error).message}`);
    }
    const path = join(next, CONTEXT_FILE);
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(
        `context "${name}": github ${repo}${ref ? ` at ${ref}` : ""} has no context.json at its root: it is not a context`,
      );
    }
    const declaration = readFileSync(path, "utf8");
    parseContextCopy(declaration, contextSource(name));
    if (found) {
      const previous = readCopyRecord(agentDir, name);
      if (
        previous.repo === repo &&
        previous.ref === ref &&
        previous.commit === commit &&
        previous.declaration === declaration &&
        existsSync(join(dir, CONTEXT_FILE)) &&
        readFileSync(join(dir, CONTEXT_FILE), "utf8") === declaration
      ) {
        return { name, commit, outcome: "current" };
      }
    }
    mkdirSync(dir, { recursive: true });
    try {
      writeFileAtomic(join(dir, CONTEXT_FILE), declaration);
      // This single rename publishes identity and declaration together; the directory never moves.
      writeFileAtomic(join(dir, COPY_RECORD), JSON.stringify({ repo, ref, commit, declaration }));
    } catch (error) {
      if (!found) rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { name, commit, outcome: "fetched" };
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
}

export interface FetchedContext {
  name: string;
  repo: string;
  ref?: string;
  commit?: string;
  description?: string;
  brings?: { content: string[]; packages: string[]; variables: string[] };
  error?: string;
}

/** A reporting boundary: a broken or missing copy is shown, not hidden by omitting the context. */
export function fetchedContexts(agentDir: string, contexts: readonly DeclaredContext[]): FetchedContext[] {
  return contexts.map((context) => {
    const { name, repo, ref } = context;
    const at = { name, repo, ...(ref !== undefined ? { ref } : {}) };
    if (!existsSync(contextCopyPath(agentDir, name))) return at;
    try {
      const { commit, declaration } = copyRecord(agentDir, context);
      const { description, content, environment } = parseContextCopy(declaration, contextSource(name));
      return {
        ...at,
        commit,
        ...(description !== undefined ? { description } : {}),
        brings: {
          content: content.map((entry) => entry.name),
          packages: [
            ...Object.keys(environment?.packages ?? {}),
            ...(environment?.aptPackages ?? []).map((apt) => `apt:${apt}`),
          ],
          variables: Object.keys(environment?.variables ?? {}),
        },
      };
    } catch (error) {
      return { ...at, error: (error as Error).message };
    }
  });
}

export async function refreshContexts(agentDir: string, contexts: readonly DeclaredContext[]): Promise<void> {
  for (const fetched of await fetchContexts(agentDir, contexts, "keep", true)) {
    const at = `context "${fetched.name}"`;
    if (fetched.outcome === "kept") {
      log.warn(`[fastagent] ${at}: runs on the copy fetched at ${fetched.commit.slice(0, 7)}: ${fetched.reason}`);
    } else {
      log.info(
        `[fastagent] ${at}: ${fetched.outcome === "fetched" ? "fetched" : "already up to date"} at ${fetched.commit.slice(0, 7)}`,
      );
    }
  }
}
