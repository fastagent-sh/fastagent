import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * This build's own @fastagent-sh/fastagent version. THROWS if unreadable — the version is load-bearing for the
 * scaffolded dependency range (`^${version}`), so `init` must never fall back and scaffold an uninstallable `^0.0.0`.
 */
export async function fastagentVersion(): Promise<string> {
  return (await fastagentBuild()).version;
}

/**
 * This build's version and the TypeScript range `fastagent build` compiles with, for a scaffolded agent to depend on.
 */
export async function fastagentBuild(): Promise<{
  version: string;
  typescript: string;
}> {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    version?: string;
    devDependencies?: Record<string, string>;
  };
  if (typeof pkg.version !== "string" || pkg.version === "") throw new Error(`no version in ${pkgPath}`);
  const typescript = pkg.devDependencies?.typescript;
  if (typescript === undefined) throw new Error(`${pkgPath} does not develop with typescript`);
  return { version: pkg.version, typescript };
}
