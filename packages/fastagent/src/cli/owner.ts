/**
 * The process that owns an instance on this machine, as the CLI's other commands reach it. One process owns an
 * instance's state, so a command that operates a running instance (`invoke`) goes
 * through it, by the Agent API, instead of opening the storage it holds. `dev` writes where it answers and a key of its
 * own into the instance's state once it listens, and removes them when it stops; a file a killed process left answers
 * nothing, and the command then opens the instance itself.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { classifyBind } from "../bind.ts";
import { log } from "../log.ts";

const OWNER_FILE = "owner.json";
const EXPECTED_STALE_CODES = new Set(["ECONNREFUSED", "ECONNRESET"]);

function errorCodesOf(error: unknown): string[] {
  const codes: string[] = [];
  for (
    let current: unknown = error;
    current !== null && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
  }
  return codes;
}

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
export async function reachOwner(
  stateRoot: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<Owner | undefined> {
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
  try {
    const response = await fetch(new URL("/v1/agent", owner.url), {
      headers: { authorization: `Bearer ${owner.key}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    return response.ok ? { url: owner.url, key: owner.key } : undefined;
  } catch (error) {
    const codes = errorCodesOf(error);
    if (!codes.some((code) => EXPECTED_STALE_CODES.has(code))) {
      const detail =
        error instanceof Error
          ? error.cause instanceof Error
            ? `${error.message}: ${error.cause.message}`
            : error.message
          : String(error);
      log.warn(`[fastagent] could not reach local owner at ${owner.url}: ${detail}`);
    }
    return undefined;
  }
}
