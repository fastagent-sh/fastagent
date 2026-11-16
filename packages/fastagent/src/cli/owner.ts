/**
 * The process that owns an instance on this machine, as the CLI's other commands reach it. One process owns an
 * instance's state, so a command that operates a running instance (`invoke`, `schedules run`, `schedules unwake`) goes
 * through it, by the Agent API, instead of opening the storage it holds. `dev` writes where it answers and a key of its
 * own into the instance's state once it listens, and removes them when it stops; a file a killed process left answers
 * nothing, and the command then opens the instance itself.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { classifyBind } from "../bind.ts";

const OWNER_FILE = "owner.json";

export interface Owner {
  /** The base URL of its Agent API. */
  url: string;
  key: string;
}

/** A key for the owner's API that only this machine's commands read, from the instance's state. */
export const ownerKey = (): string => randomBytes(32).toString("base64url");

/** Say that this process owns the instance in `stateRoot`, answering at `host:port`; the returned function unsays it. */
export function announceOwner(stateRoot: string, host: string | undefined, port: number, key: string): () => void {
  const reachable = host === undefined || classifyBind(host) === "wildcard" ? "127.0.0.1" : host;
  const file = join(stateRoot, OWNER_FILE);
  const owner: Owner = { url: `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${port}`, key };
  writeFileAtomic(file, JSON.stringify(owner), 0o600);
  return () => rmSync(file, { force: true });
}

/** The process serving the instance in `stateRoot`, when one answers. */
export async function reachOwner(stateRoot: string): Promise<Owner | undefined> {
  let text: string;
  try {
    text = readFileSync(join(stateRoot, OWNER_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const owner = JSON.parse(text) as Partial<Owner>;
  if (typeof owner.url !== "string" || typeof owner.key !== "string") {
    throw new Error(`${join(stateRoot, OWNER_FILE)} is not an owner's: remove it, then run the command again`);
  }
  // Asked with its key: another serve on the port a killed owner left (dev's default is one port) answers /health too.
  const answered = await fetch(new URL("/v1/agent", owner.url), {
    headers: { authorization: `Bearer ${owner.key}` },
    signal: AbortSignal.timeout(2_000),
  }).then(
    (response) => response.ok,
    () => false,
  );
  return answered ? { url: owner.url, key: owner.key } : undefined;
}
