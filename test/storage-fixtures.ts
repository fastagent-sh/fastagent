import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const STORAGE = pathToFileURL(new URL("../src/harnesses/pi-durable/storage.ts", import.meta.url).pathname).href;

/** Open the storage at `path` in another process, as a second `dev` or `start` would: what it reported. */
export async function openElsewhere(path: string): Promise<string> {
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
