import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";

export const made: string[] = [];

export const agents: LocalAgent[] = [];

export const scratch = (parent: string, prefix: string) => {
  const dir = mkdtempSync(join(parent, prefix));
  made.push(dir);
  return dir;
};

/** Every file of `dir` with a hash of its content: what "the package was not written to" is compared on. */
export const snapshot = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return `${file.slice(dir.length + 1)} ${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    })
    .sort();

export const setMode = (dir: string, file: number, directory: number) => {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? directory : file);
  }
  chmodSync(dir, directory);
};

export const readOnly = (dir: string) => setMode(dir, 0o444, 0o555);

export async function ask(agent: LocalAgent, name: string, args: Record<string, unknown>) {
  const session = await agent.sessions.create();
  const end = await agent.messages.send(
    { sessionId: session.id, content: JSON.stringify({ name, args }) },
    { wait: 30 },
  );
  expect(end.status).toBe("completed");
  return end;
}
