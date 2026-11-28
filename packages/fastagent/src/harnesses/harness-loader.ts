/**
 * Runtime harness loader: returns the built-in `pi-durable` provider or dynamically loads an installed optional
 * `@fastagent-sh/harness-<name>/provider` plugin from the runtime or project directory.
 */
import { pathToFileURL } from "node:url";
import type { HarnessProvider } from "../harness.ts";
import { isBunRuntime, resolveFromProject } from "../runtime.ts";
import { harnessPackage } from "./config.ts";
import type { HarnessName } from "./define.ts";
import { piDurableProvider } from "./pi-durable/runtime.ts";

/** Resolve the built-in `pi-durable` provider or dynamically load `@fastagent-sh/harness-<name>/provider`. */
export async function resolveHarnessProvider(
  harness: HarnessName,
  projectDir: string,
  resolveFromSelf: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): Promise<HarnessProvider> {
  if (harness === "pi-durable") return piDurableProvider as HarnessProvider;
  const pkgName = harnessPackage(harness);
  if (pkgName === undefined) throw new Error(`unknown harness "${harness}"`);
  const specifier = `${pkgName}/provider`;
  let entryUrl: string;
  try {
    entryUrl = resolveFromSelf(specifier);
  } catch (firstError) {
    const firstCode = (firstError as { code?: unknown }).code;
    if (firstCode !== "ERR_MODULE_NOT_FOUND" && firstCode !== "MODULE_NOT_FOUND") throw firstError;
    const resolved = resolveFromProject(projectDir, specifier);
    if (resolved === undefined) {
      const installHint = isBunRuntime() ? `bun add ${pkgName}` : `npm install ${pkgName}`;
      throw new Error(`harness "${harness}" requires ${pkgName}. Install it in your project: ${installHint}`, {
        cause: firstError,
      });
    }
    entryUrl = pathToFileURL(resolved).href;
  }
  const mod = (await import(entryUrl)) as Partial<{ readonly harnessProvider: HarnessProvider }>;
  if (
    mod.harnessProvider === undefined ||
    typeof mod.harnessProvider.openStorage !== "function" ||
    typeof mod.harnessProvider.openAgent !== "function"
  ) {
    throw new Error(`${specifier} does not export a valid harnessProvider`);
  }
  return mod.harnessProvider;
}
