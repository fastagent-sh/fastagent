/**
 * A built package opened on Bun, where vitest does not run: CI's Bun job runs this file (`bun test/bun/built.ts`), and
 * test/built-package.integration.test.ts holds the same contract on Node. The package is built, installed under an app's
 * `node_modules`, made read-only, and opened as two instances that each answer a message.
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuiltDefinition } from "../../src/harnesses/pi-durable/built.ts";
import { openAgent } from "../../src/harnesses/pi-durable/serve.ts";
import { FIXTURES, installProbe } from "../probe-package.ts";

if (typeof process.versions.bun !== "string") throw new Error("run this with bun: bun test/bun/built.ts");

const made: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(prefix.startsWith(".tmp") ? FIXTURES : tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const walk = (dir: string, mode: (directory: boolean) => number) => {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    chmodSync(join(entry.parentPath, entry.name), mode(entry.isDirectory()));
  }
  chmodSync(dir, mode(true));
};

let installed: string | undefined;
try {
  installed = await installProbe(scratch(".tmp-bun-project-"), scratch(".tmp-bun-app-"));
  walk(installed, (directory) => (directory ? 0o555 : 0o444));
  const definition = await loadBuiltDefinition(installed);
  const roots = [scratch("fa-bun-a-"), scratch("fa-bun-b-")];
  for (const root of roots) {
    const agent = await openAgent(definition, { root, offline: true });
    const session = await agent.sessions.create();
    const end = await agent.messages.send(
      { sessionId: session.id, content: JSON.stringify({ name: "write", args: { path: "out.txt", content: root } }) },
      { wait: 30 },
    );
    await agent.close();
    if (end.status !== "completed" || readFileSync(join(root, "out.txt"), "utf8") !== root) {
      throw new Error(`the instance in ${root} did not answer: ${JSON.stringify(end)}`);
    }
  }
  console.log("ok   a built package opens read-only as two instances, each writing in its own directory");
} finally {
  if (installed !== undefined) walk(installed, (directory) => (directory ? 0o755 : 0o644));
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
