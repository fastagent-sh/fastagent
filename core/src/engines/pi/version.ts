import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * This build's own @kid7st/fastagent version. THROWS if unreadable — the version is load-bearing for
 * the scaffolded dependency range (`^${version}`), so init must never scaffold an uninstallable `^0.0.0`.
 */
export async function fastagentVersion(): Promise<string> {
  const pkgPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version === "") throw new Error(`no version in ${pkgPath}`);
  return pkg.version;
}
