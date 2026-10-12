/**
 * Fetch contexts into .contexts/<name>, validating a fresh snapshot before replacing the copy. Development can use a
 * cached copy when its remote is unreachable; add, fetch and deploy cannot. Production only reads copies. A copy whose
 * commit is the one its remote names is left alone without fetching anything: the common case is that nothing moved.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { withLockedFile } from "../locked-file.ts";
import lockfile from "proper-lockfile";
import { fetchSnapshot, remoteCommit } from "../content/git.ts";
import { loadContexts, parseContextCopy } from "../content/file.ts";
import { log } from "../log.ts";
import { CONTEXT_FILE, contextCopyPath, isUnderDir } from "../paths.ts";
import { COPY_RECORD, copyRecord, readCopyRecord } from "./copy.ts";
import { writeFileAtomic } from "../atomic-write.ts";
import { type DeclaredContext, contextSource, declareContexts } from "./declare.ts";

export type ContextFetch = { name: string; commit: string } & (
  | { outcome: "fetched" | "current" }
  | { outcome: "kept"; reason: string }
);

/**
 * The lock is transient process coordination, not a version lock: fetch and remove must not replace each other's copy.
 * It is held across a clone, which can outlast the staleness window (a laptop that sleeps), and a lock judged
 * compromised must be reported rather than thrown from a timer inside this process (`proper-lockfile`'s default, which
 * is an uncaught exception): `assertOwned` is the state check, as in `src/locked-file.ts`.
 */
export async function withContextCopy<T>(
  agentDir: string,
  name: string,
  use: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  const dir = contextCopyPath(agentDir, name);
  const root = dirname(dir);
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${root} is a link: contexts must be fetched inside the agent directory`);
  }
  mkdirSync(root, { recursive: true });
  let compromised: Error | undefined;
  const assertOwned = (): void => {
    if (compromised !== undefined) {
      throw new Error(`the lock for ${dir} was lost while it was held (${compromised.message}): retry the fetch`);
    }
  };
  const release = await lockfile.lock(dir, {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
    stale: 30_000,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  let result: T;
  try {
    result = await use(assertOwned);
  } catch (error) {
    // The primary failure stays the signal; a compromised lock often cannot release cleanly.
    if (compromised === undefined) await release();
    throw error;
  }
  try {
    await release();
  } catch (releaseError) {
    // A failed release is a real cleanup failure (a leftover lock stalls the next writer for the staleness window with
    // no diagnostics), so it surfaces — unless the lock was already lost, which is the stronger fact.
    if (compromised === undefined) throw releaseError;
  }
  assertOwned();
  return result;
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
  return withLockedFile(
    join(agentDir, CONTEXT_FILE),
    async () => {
      const outcomes = await Promise.allSettled(
        checked.map((context) =>
          withContextCopy(agentDir, context.name, (assertOwned) => {
            if (
              requireListed &&
              !loadContexts(agentDir).some(
                (one) => one.name === context.name && one.repo === context.repo && one.ref === context.ref,
              )
            ) {
              throw new Error(`context "${context.name}" is no longer declared at that repository and ref`);
            }
            return fetchOne(agentDir, context, onFailure, assertOwned);
          }),
        ),
      );
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return { result: outcomes.map((outcome) => (outcome as PromiseFulfilledResult<ContextFetch>).value) };
    },
    { create: false },
  );
}

async function fetchOne(
  agentDir: string,
  context: DeclaredContext,
  onFailure: "keep" | "fail",
  assertOwned: () => void,
): Promise<ContextFetch> {
  const { name, repo, ref } = context;
  const dir = contextCopyPath(agentDir, name);
  const found = lstatSync(dir, { throwIfNoEntry: false });
  if (found && (!found.isDirectory() || !existsSync(join(dir, COPY_RECORD)))) {
    throw new Error(`${dir} is not a fetched context copy: move it away before fetching`);
  }
  const keptOr = (error: unknown): ContextFetch => {
    if (onFailure === "keep" && found) {
      const had = copyRecord(agentDir, context);
      return { name, commit: had.commit, outcome: "kept", reason: (error as Error).message };
    }
    throw new Error(`context "${name}": ${(error as Error).message}`);
  };
  let remote: string | undefined;
  try {
    remote = await remoteCommit(repo, ref, agentDir);
  } catch (error) {
    return keptOr(error);
  }
  if (remote !== undefined && recorded(agentDir, dir, context, remote) !== undefined) {
    return { name, commit: remote, outcome: "current" };
  }
  const next = mkdtempSync(join(tmpdir(), "fastagent-context-"));
  try {
    if (isUnderDir(realpathSync(next), realpathSync(agentDir))) {
      throw new Error(`temporary context clones must be outside ${agentDir}: set TMPDIR to another directory`);
    }
    let snapshot: Awaited<ReturnType<typeof fetchSnapshot>>;
    try {
      snapshot = await fetchSnapshot(repo, ref, next);
    } catch (error) {
      return keptOr(error);
    }
    if (snapshot.declaration === undefined) {
      throw new Error(
        `context "${name}": github ${repo}${ref ? ` at ${ref}` : ""} has no context.json at its root: it is not a context`,
      );
    }
    const declaration = snapshot.declaration;
    const commit = snapshot.commit;
    if (found && recorded(agentDir, dir, context, commit) === declaration) {
      return { name, commit, outcome: "current" };
    }
    parseContextCopy(declaration, contextSource(name));
    mkdirSync(dir, { recursive: true });
    try {
      assertOwned();
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

/**
 * The declaration the copy `dir` already holds for `commit`, or undefined when it does not hold that commit: its
 * record checked against the mirror file, so a copy that is already what was asked for is not written again. The
 * record alone would be one writer's word for it; the mirror file is what every reader opens.
 */
function recorded(agentDir: string, dir: string, context: DeclaredContext, commit: string): string | undefined {
  if (!existsSync(join(dir, COPY_RECORD)) || !existsSync(join(dir, CONTEXT_FILE))) return undefined;
  const previous = readCopyRecord(agentDir, context.name);
  if (previous.repo !== context.repo || previous.ref !== context.ref || previous.commit !== commit) return undefined;
  return readFileSync(join(dir, CONTEXT_FILE), "utf8") === previous.declaration ? previous.declaration : undefined;
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
