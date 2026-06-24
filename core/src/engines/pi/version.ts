import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * This build's own @kid7st/fastagent version (from the package's package.json). THROWS if it can't be
 * read — a real version is load-bearing for the scaffolded dependency range (`^${version}`), so init
 * must fail visibly rather than ever scaffold an uninstallable `^0.0.0`. The manifest writer (build),
 * for which the version is only provenance, defaults locally instead.
 */
export async function fastagentVersion(): Promise<string> {
  const pkgPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version === "") throw new Error(`no version in ${pkgPath}`);
  return pkg.version;
}
