import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * This build's own @fastagent-sh/fastagent version. THROWS if unreadable — the version is load-bearing for the
 * scaffolded dependency range (`^${version}`), so `init` must never fall back and scaffold an uninstallable `^0.0.0`.
 */
export async function fastagentVersion(): Promise<string> {
  return (await fastagentBuild()).version;
}

/** The packages an agent's code imports besides fastagent: the harness its tools and providers are written for. */
const HARNESS_PACKAGES = ["@earendil-works/pi-durable", "@earendil-works/pi-ai"];

/** This build's version, and the exact versions of the harness packages it runs, for a new agent to depend on. */
export async function fastagentBuild(): Promise<{ version: string; harness: Record<string, string> }> {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
  };
  if (typeof pkg.version !== "string" || pkg.version === "") throw new Error(`no version in ${pkgPath}`);
  const harness: Record<string, string> = {};
  for (const name of HARNESS_PACKAGES) {
    const range = pkg.dependencies?.[name];
    if (range === undefined) throw new Error(`${pkgPath} does not depend on ${name}`);
    harness[name] = range;
  }
  return { version: pkg.version, harness };
}
