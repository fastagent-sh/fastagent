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
export const HARNESS_PACKAGES = ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/pi-schema"];

/** The SDK Feishu and Lark WebSocket ingress loads: an optional peer, so only an agent with those channels installs it. */
export const FEISHU_SDK = "@larksuiteoapi/node-sdk";

/**
 * This build's version, the exact versions of the harness packages it runs, and the TypeScript `fastagent build`
 * compiles with (FastAgent's own), for a new agent to depend on.
 */
export async function fastagentBuild(): Promise<{
  version: string;
  harness: Record<string, string>;
  typescript: string;
  feishuSdk: string;
}> {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  if (typeof pkg.version !== "string" || pkg.version === "") throw new Error(`no version in ${pkgPath}`);
  const harness: Record<string, string> = {};
  for (const name of HARNESS_PACKAGES) {
    const range = pkg.dependencies?.[name];
    if (range === undefined) throw new Error(`${pkgPath} does not depend on ${name}`);
    harness[name] = range;
  }
  const typescript = pkg.devDependencies?.typescript;
  if (typescript === undefined) throw new Error(`${pkgPath} does not develop with typescript`);
  const feishuSdk = pkg.peerDependencies?.[FEISHU_SDK];
  if (feishuSdk === undefined) throw new Error(`${pkgPath} does not declare the peer ${FEISHU_SDK}`);
  return { version: pkg.version, harness, typescript, feishuSdk };
}
