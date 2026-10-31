import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it } from "vitest";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";

const STORAGE = pathToFileURL(new URL("../src/harnesses/pi-durable/storage.ts", import.meta.url).pathname).href;

/** Open the storage at `path` in another process, as a second `dev` or `start` would: what it reported. */
async function openElsewhere(path: string): Promise<string> {
  const script = `
const { openLockedStorage } = await import(${JSON.stringify(STORAGE)});
try {
  await openLockedStorage(${JSON.stringify(path)}, "posix", "the other test");
  console.log("opened");
} catch (error) {
  console.log(error.message);
}`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
  return stdout.trim();
}

it("a second process cannot open the storage one process holds, and can once it is closed", async () => {
  // WAL alone lets a second process open and write the file, and both would resume and run the same messages.
  const path = join(await mkdtemp(join(tmpdir(), "fa-storage-")), ".state", "agent.sqlite");
  const held = await openLockedStorage(path, "posix", "the other test");
  expect(await openElsewhere(path)).toMatch(
    /^the storage .*agent\.sqlite is held by another process: the other test is running/,
  );
  await held.close(BACKGROUND_CONTEXT);
  expect(await openElsewhere(path)).toBe("opened");
});

it("a storage written by a newer pi-durable is refused saying so, not with a second close's error", async () => {
  // A deployment rolled back past a release that migrated its database (pi-durable 1.4.0 rewrote the task table).
  const path = join(await mkdtemp(join(tmpdir(), "fa-storage-newer-")), "agent.sqlite");
  await (await openLockedStorage(path, "posix")).close(BACKGROUND_CONTEXT);
  const database = new DatabaseSync(path);
  database.exec("UPDATE durable_schema SET version = version + 1");
  database.close();
  await expect(openLockedStorage(path, "posix")).rejects.toThrow(/schema version \d+ is newer than supported/);
});

it("an agent that fails to open lets go of the storage, so the same process can open it once fixed", async () => {
  // An embedder that corrects its configuration retries in the process it runs in, which still holds the lock.
  const dir = await mkdtemp(join(tmpdir(), "fa-storage-retry-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await expect(openServing(dir, { model: "nope/missing" })).rejects.toThrow(/unknown model "nope\/missing"/);
  const opened = await openServing(dir, { model: "anthropic/claude-sonnet-4-5" });
  await opened.agent.close();
});
