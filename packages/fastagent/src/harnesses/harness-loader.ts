/**
 * Runtime harness loader: lazily imports the built-in `pi-durable` provider, dynamically loads an installed
 * `@fastagent-sh/harness-<name>/provider` plugin from the runtime or project directory, or validates a directly
 * injected `HarnessProvider` object.
 */
import { pathToFileURL } from "node:url";
import type { HarnessProvider } from "../harness.ts";
import { isBunRuntime, resolveFromProject } from "../runtime.ts";
import { harnessPackage } from "./config.ts";
import type { HarnessName } from "./define.ts";

function isHarnessProvider(value: unknown): value is HarnessProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<HarnessProvider>).name === "string" &&
    typeof (value as Partial<HarnessProvider>).openStorage === "function" &&
    typeof (value as Partial<HarnessProvider>).openAgent === "function"
  );
}

/** Resolve `"pi-durable"`, a direct `HarnessProvider`, or `@fastagent-sh/harness-<name>/provider`. */
export async function resolveHarnessProvider(
  harness: HarnessName | HarnessProvider,
  projectDir: string,
  resolveFromSelf: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): Promise<HarnessProvider> {
  if (typeof harness !== "string") {
    if (!isHarnessProvider(harness)) {
      throw new Error("harness option must be a harness name or a valid HarnessProvider");
    }
    return harness;
  }
  if (harness === "pi-durable") {
    const { piDurableProvider } = await import("./pi-durable/runtime.ts");
    return piDurableProvider as HarnessProvider;
  }
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
  if (!isHarnessProvider(mod.harnessProvider)) {
    throw new Error(`${specifier} does not export a valid harnessProvider`);
  }
  return mod.harnessProvider;
}
