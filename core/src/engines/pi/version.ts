import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** This build's own @kid7st/fastagent version — for the artifact manifest and scaffolded deps. */
export async function fastagentVersion(): Promise<string> {
  try {
    const pkgPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
