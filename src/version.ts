import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** This build's own @fastagent-sh/fastagent version. */
export async function fastagentVersion(): Promise<string> {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version === "") throw new Error(`no version in ${pkgPath}`);
  return pkg.version;
}
