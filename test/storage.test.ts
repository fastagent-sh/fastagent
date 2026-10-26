import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it } from "vitest";
import { openInstanceStorage } from "../src/harnesses/pi-durable/storage.ts";

const STORAGE = pathToFileURL(new URL("../src/harnesses/pi-durable/storage.ts", import.meta.url).pathname).href;

/** Open the storage at `path` in another process, as a second `dev` or `start` would: what it reported. */
async function openElsewhere(path: string): Promise<string> {
  const script = `
const { openInstanceStorage } = await import(${JSON.stringify(STORAGE)});
try {
  await openInstanceStorage(${JSON.stringify(path)}, "posix");
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
  const held = await openInstanceStorage(path, "posix");
  expect(await openElsewhere(path)).toMatch(/^the storage .*agent\.sqlite is held by another process/);
  await held.close(BACKGROUND_CONTEXT);
  expect(await openElsewhere(path)).toBe("opened");
});
