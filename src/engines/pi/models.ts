/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId lookup) AND auth
 * (per-request credential resolution). fastagent builds one per opener and threads it into the engine alongside the
 * selected `model`; the two must come from the same collection so the model's provider auth is in scope.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type CredentialStore,
  InMemoryCredentialStore,
  type Model,
  type Models,
  type Provider,
  defaultProviderAuthContext,
} from "@earendil-works/pi-ai";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type FastagentAuthOptions, fastagentCredentialStore } from "./auth.ts";
import { providerOf } from "./config.ts";
import { AGENT_MODELS_FILE, GLOBAL_HOME_DIR, resolveOverridePath, resolveStateRoot } from "../../paths.ts";
import { writeFileAtomic } from "../../atomic-write.ts";

/** The DEFINITION-LOCAL custom-endpoint file, in pi's own models.json schema (see pi's docs/models.md). */

export interface CreatePiModelsOptions extends FastagentAuthOptions {
  authPath?: string;
  /**
   * Read a provider the primary file does not have from here instead (`resolveAuthFallback`: the user-global store).
   * Omitted by an embedder that named its own store — "use this file" is an instruction, not a preference.
   */
  fallbackAuthPath?: string;
  /** Extra providers registered on top of the built-ins (same id overrides a built-in). */
  providers?: Provider[];
}

/** A `Models` with every built-in pi provider, wired to fastagent's auth. */
export function createPiModels(options: CreatePiModelsOptions = {}): Models {
  return piModelsOver(
    fastagentCredentialStore(options.authPath, {
      warn: options.warn,
      ...(options.fallbackAuthPath !== undefined ? { fallbackPath: options.fallbackAuthPath } : {}),
    }),
    options.providers,
  );
}

/** The built-ins plus `providers` (a same id replaces a built-in), over any credential store. */
export function piModelsOver(credentials: CredentialStore, providers: readonly Provider[] = []): Models {
  const models = builtinModels({ credentials, authContext: defaultProviderAuthContext() });
  for (const provider of providers) models.setProvider(provider);
  return models;
}

/**
 * pi's Model with the API-shape generic erased — fastagent only passes models through to the engine, so the generic
 * carries no information.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly model type, audited at this single point
export type AnyModel = Model<any>;

/** The serving default for reasoning effort, pinned to what pi's TUI defaults to (its own DEFAULT_THINKING_LEVEL). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * The MACHINE's custom-endpoint file, in the same schema as an agent's own: endpoints a person set up for this machine
 * (a local Ollama, a company gateway), which every agent here inherits the way it inherits the machine's skills.
 * `FASTAGENT_MODELS_PATH` moves it. It never ships: a deployed agent has only its definition's file.
 */
export function machineModelsPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_MODELS_PATH) ?? join(homedir(), GLOBAL_HOME_DIR, AGENT_MODELS_FILE);
}

/** A custom-endpoint file's providers by id, or undefined when there is no file. Strict JSON: see {@link modelLayers}. */
async function readProviders(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`could not read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    throw new Error(`${path} must hold { "providers": { ... } }`);
  }
  return providers as Record<string, unknown>;
}

/**
 * The two custom-endpoint layers of an agent, read ONCE for every reader: the file pi loads and the report of where a
 * provider came from both come from this, so what runs and what `info`/`deploy` say cannot disagree. Undefined when
 * the machine has no file: then the agent's own file goes to pi untouched.
 *
 * Read here rather than by pi, because pi loads exactly one path and its comment stripping is not reachable: while a
 * machine file exists, both files must be plain JSON.
 */
async function modelLayers(
  agentDir: string,
): Promise<{ machinePath: string; machine: Record<string, unknown>; own: Record<string, unknown> } | undefined> {
  const machinePath = machineModelsPath();
  const machine = await readProviders(machinePath);
  if (!machine) return undefined;
  return { machinePath, machine, own: (await readProviders(join(agentDir, AGENT_MODELS_FILE))) ?? {} };
}

/**
 * The models.json pi loads for an agent: its own file, layered over the machine's. The agent's file wins a provider id
 * outright, as a definition's skill wins a name: an agent that pins an endpoint keeps it.
 *
 * The merge is a SNAPSHOT named by its content, in fastagent's own home: not in the agent (so `info` writes nothing
 * there), and not in a shared temp dir, which the OS clears while a long-running process still re-reads it (pi
 * reloads `modelsPath` on every refresh). Content addressing is what lets every process share the directory: a
 * snapshot is never rewritten, so no process can change what another's refresh reads. The price is that a running
 * process keeps the snapshot it started with; an edit to either file takes effect on the next start.
 *
 * ponytail: snapshots are never pruned (one per distinct content, a few KB each) because a running process may still
 * read an old one; delete the directory while no fastagent process runs if it ever matters.
 */
async function modelsFileFor(
  agentDir: string,
): Promise<{ path: string; merged?: { machine: string; definition: string } }> {
  const definition = join(agentDir, AGENT_MODELS_FILE);
  const layers = await modelLayers(agentDir);
  if (!layers) return { path: definition };
  const content = JSON.stringify({ providers: { ...layers.machine, ...layers.own } }, null, 2);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const path = join(homedir(), GLOBAL_HOME_DIR, ".cache", "models", `${hash}.json`);
  // 0600: it may carry literal keys. Several processes may create the same snapshot at once.
  if (!existsSync(path)) writeFileAtomic(path, content, 0o600, true);
  return { path, merged: { machine: layers.machinePath, definition } };
}

/**
 * Where an agent's custom endpoints come from, for a report: the machine file, the providers the agent inherits from
 * it, and the ones its own file overrides. Undefined when the machine has no file.
 */
export async function machineModels(
  agentDir: string,
): Promise<{ path: string; inherited: string[]; overridden: string[] } | undefined> {
  const layers = await modelLayers(agentDir);
  if (!layers) return undefined;
  const ids = Object.keys(layers.machine).sort();
  return {
    path: layers.machinePath,
    inherited: ids.filter((id) => !(id in layers.own)),
    overridden: ids.filter((id) => id in layers.own),
  };
}

/** Whether pi ships this provider id itself, so an agent resolves it without any models.json entry. */
export function isBuiltinProvider(providerId: string): boolean {
  return builtinProviders().some((provider) => provider.id === providerId);
}

/** The `ModelRuntime`-shaped sibling of {@link createPiModels}. */
export async function createPiModelRuntime(
  options: FastagentAuthOptions & {
    authPath?: string;
    /** Read a provider the primary file does not have from here instead ({@link CreatePiModelsOptions}). */
    fallbackAuthPath?: string;
    /** The agent dir, whose {@link AGENT_MODELS_FILE} declares custom endpoints. */
    agentDir?: string;
    /**
     * Layer the machine's models.json under the agent's (default). Off for the registry a DEPLOYED agent has, which
     * `deploy` must judge by: the machine's file does not ship.
     */
    machineLayer?: boolean;
    /** Where the dynamic model-catalog cache goes; defaults to the agent's resolved state root. */
    stateRoot?: string;
    /** Extra providers for the ids the built-ins do not cover. */
    providers?: Provider[];
  } = {},
): Promise<ModelRuntime> {
  const { agentDir } = options;
  const models = !agentDir
    ? undefined
    : options.machineLayer === false
      ? { path: join(agentDir, AGENT_MODELS_FILE) }
      : await modelsFileFor(agentDir);
  const runtime = await ModelRuntime.create({
    credentials: fastagentCredentialStore(options.authPath, {
      warn: options.warn,
      ...(options.fallbackAuthPath !== undefined ? { fallbackPath: options.fallbackAuthPath } : {}),
    }),
    modelsPath: models?.path ?? null,
    // MUST be set whenever modelsPath is: pi defaults this to `<dirname(modelsPath)>/models-store.json`, which would
    // write a generated cache INTO the author's agent dir.
    ...(agentDir
      ? { modelsStorePath: join(options.stateRoot ?? resolveStateRoot(agentDir), "models-store.json") }
      : {}),
    allowModelNetwork: false,
  });
  // A malformed models.json does NOT throw upstream — `create` resolves with the built-ins and parks the reason in
  // getError().
  const error = runtime.getError();
  if (error) {
    const origin = models?.merged
      ? `\n\nThat file merges ${models.merged.machine} with ${models.merged.definition} (the agent's own wins a provider id).`
      : "";
    throw new Error(`${error}${origin}`);
  }
  for (const provider of options.providers ?? []) runtime.registerNativeProvider(provider);
  return runtime;
}

/** How a model's credential will REACH a deployed agent. */
export function modelCredentialCarry(runtime: ModelRuntime, spec: string): { envVar?: string; inDefinition: boolean } {
  const status = runtime.getProviderAuthStatus(providerOf(spec));
  if (!status.configured) return { inDefinition: false };
  // An env-var name is only useful downstream if it IS one.
  if (status.source === "environment" && status.label && /^[A-Z][A-Z0-9_]*$/.test(status.label)) {
    return { envVar: status.label, inDefinition: false };
  }
  return { inDefinition: status.source !== "stored" };
}

/**
 * EVERY provider whose `models.json` entry writes its key as a LITERAL rather than a `"$NAME"` reference or a
 * `"!cmd"`. The file ships inside the image, so a literal there is a credential in a readable layer.
 *
 * Read from the FILE, not from `getProviderAuthStatus`: that answers "what satisfies this provider right now" and
 * returns `stored` first, so a provider that has both an `auth.json` entry and a literal in the file would report
 * `stored` and the literal would go unreported. The question is what the definition DECLARES, and only the file
 * answers it. The three-way split mirrors pi's `configuredRequestAuthStatus`, which is not exported.
 *
 * The caller WARNS on this; it does not refuse. Whether a given string is a credential is the author's knowledge,
 * not the framework's — pi's own docs prescribe `"apiKey": "ollama"` for a keyless local server, and no static rule
 * separates that from a leaked key (an endpoint's reachability is not decidable from its URL either). FastAgent
 * gates what IT causes; what the author wrote into their own committed file, it reports.
 */
export async function literalKeyProviders(agentDir: string): Promise<string[]> {
  const file = join(agentDir, AGENT_MODELS_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // No custom endpoints is the normal case; anything else (unreadable, a directory) is the caller's problem.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // Malformed JSON already threw out of createPiModelRuntime before this runs, so a parse failure here would be a
  // genuine surprise and must not be swallowed.
  const providers = (JSON.parse(raw) as { providers?: Record<string, { apiKey?: unknown }> }).providers ?? {};
  return Object.entries(providers)
    .filter(([, provider]) => isLiteralKey(provider?.apiKey))
    .map(([id]) => id);
}

/**
 * `!cmd` runs on the box; `$NAME` / `${NAME}` reads the environment; anything else is the key itself.
 *
 * `$$` is pi's escape for a literal `$`, so it is removed BEFORE looking for a reference — otherwise `"sk$$abc"`
 * (which resolves to the literal `sk$abc`) would read as a reference and go unmentioned.
 */
function isLiteralKey(apiKey: unknown): boolean {
  if (typeof apiKey !== "string" || apiKey === "" || apiKey.startsWith("!")) return false;
  return !/\$\{?[A-Za-z_]/.test(apiKey.replaceAll("$$", ""));
}

/**
 * What a provider can offer as an interactive login: an OAuth flow, an API-key ENTRY prompt, or nothing ("none" — the
 * key must come from the provider's env var).
 */
export type InteractiveLoginKind = "oauth" | "api_key" | "none";

export function interactiveLoginKind(p: Provider): InteractiveLoginKind {
  if (interactiveAuth(p, "oauth")) return "oauth";
  return interactiveAuth(p, "api_key") ? "api_key" : "none";
}

/** THE rule for "can this method be signed in to interactively": the auth to run for it, or undefined. */
export function interactiveAuth(provider: Provider, method: Exclude<InteractiveLoginKind, "none">) {
  return method === "oauth" ? provider.auth.oauth : provider.auth.apiKey?.login ? provider.auth.apiKey : undefined;
}

/** The providers a sign-in can target: pi's built-ins plus `extra`, composed exactly as {@link createPiModels} does. */
export function loginProviders(extra?: readonly Provider[]): readonly Provider[] {
  return piModelsOver(new InMemoryCredentialStore(), extra).getProviders();
}

/** Per-provider auth status for the first-run model picker. */
export type ProviderAuthStatus =
  | { state: "ready"; source?: string }
  | { state: "unconfigured"; login: InteractiveLoginKind }
  | { state: "broken"; message: string; login: InteractiveLoginKind };

/** Probe every provider's auth once (auth is provider-scoped, so any of its models works as the probe). */
export async function providerAuthStatuses(models: Models): Promise<Map<string, ProviderAuthStatus>> {
  const statuses = new Map<string, ProviderAuthStatus>();
  for (const provider of models.getProviders()) {
    const [probe] = provider.getModels();
    if (!probe) continue;
    const login = interactiveLoginKind(provider);
    try {
      const auth = await models.getAuth(probe);
      statuses.set(provider.id, auth ? { state: "ready", source: auth.source } : { state: "unconfigured", login });
    } catch (error) {
      statuses.set(provider.id, { state: "broken", message: (error as Error).message, login });
    }
  }
  return statuses;
}

/** Which source currently satisfies auth for `spec` — a startup diagnostic. */
export async function probeAuthSource(models: Models, spec: string): Promise<string | undefined> {
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) return undefined;
  const auth = await models.getAuth(model).catch(() => undefined);
  return auth?.source;
}

/**
 * Verdict of {@link probeApiKey}: `rejected` is DEFINITIVE (the provider answered HTTP 401 — the key is wrong);
 * everything else non-ok is `unknown`.
 */
export type KeyProbe = { state: "ok" } | { state: "rejected" | "unknown"; message: string };

/** Quick-fail probe for a just-stored API key. */
export async function probeApiKey(models: Models, model: Model<Api>, signal?: AbortSignal): Promise<KeyProbe> {
  let status: number | undefined;
  let reply: Awaited<ReturnType<Models["complete"]>>;
  try {
    reply = await models.complete(
      model,
      { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
      {
        maxTokens: 16,
        timeoutMs: 15_000,
        maxRetries: 0,
        ...(signal ? { signal } : {}),
        onResponse: (r) => {
          status = r.status;
        },
      },
    );
  } catch (error) {
    // Thrown = before/around the request (auth resolution, transport setup) — not a provider verdict.
    return { state: "unknown", message: (error as Error).message };
  }
  if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return { state: "ok" };
  const message = reply.errorMessage ?? `stopReason "${reply.stopReason}"`;
  const unauthorized = status === 401 || (status === undefined && /(^|\D)401(\D|$)/.test(message));
  return { state: unauthorized ? "rejected" : "unknown", message };
}
