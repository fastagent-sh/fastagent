/**
 * The model lists a pi-ai release does not carry yet. pi publishes the catalog of every built-in provider at pi.dev;
 * when it is newer than the data this pi-ai was built with, each built-in provider lists its models too, so a model a
 * provider releases can be named without a FastAgent release. A provider that fetches its own list (radius, a provider
 * in code with `fetchModels`) is refreshed by pi-ai, with the credential that needs. Both are kept in the instance's
 * state, so a start without the network, or whose refresh fails, has the lists it last had.
 *
 * Adapted from pi-coding-agent's `remote-catalog-provider` (MIT). Two differences: one request answers for every
 * provider, and the published catalog is fetched whatever this machine authenticates (pi-ai's refresh asks the network
 * only for a provider holding a credential), because a deployed box opens its agent, default model checked, before
 * anyone logs in on it.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AnyModel,
  InMemoryModelsStore,
  type Models,
  type ModelsStore,
  type ModelsStoreEntry,
  type Provider,
  getModelType,
  isModelType,
} from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { writeFileAtomic } from "../../atomic-write.ts";

const PUBLISHED_URL = "https://pi.dev/api/models";
/** The model types this pi-ai takes; asked for, since pi.dev answers a client that names none with chat models only. */
const MODEL_TYPES = ["chat", "image", "classifier"];
/** How long a fetched catalog counts as current, so a start inside it asks the network nothing. pi's own. */
const FRESH_MS = 4 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;

/** `1`: no model list is fetched, and each is the one last kept. */
const OFFLINE_VARIABLE = "FASTAGENT_OFFLINE";

/** pi's published catalog as it was last fetched. */
interface Published {
  /**
   * The pi-ai it was fetched for. pi.dev answers each pi-ai version the newest catalog that version can read, and a
   * published model replaces the built-in one of its id, so a catalog fetched for another version is not this one's.
   */
  piAi: string;
  /** pi.dev's `Last-Modified`: what says whether the catalog is newer than this pi-ai's. */
  lastModified: number;
  etag?: string;
  checkedAt: number;
  models: Record<string, AnyModel[]>;
}

export interface Catalogs {
  /** A built-in provider, listing what the published catalog adds to it; one that fetches its own list, as it is. */
  over(provider: Provider): Provider;
  /** Where pi-ai keeps the list of a provider that fetches its own. */
  fetched: ModelsStore;
  /**
   * Bring the lists of `models` (built over {@link over} and {@link fetched}) up to date: the kept ones, then, unless
   * {@link OFFLINE_VARIABLE} is set, what the network has newer. Never rejects: resolves with why a list is not
   * current, when one is not.
   */
  refresh(models: Models, options?: { force?: boolean }): Promise<string | undefined>;
}

/** The catalogs kept in `dir`, or, without one, for this process alone. `url` and `timeoutMs` are for tests. */
export function catalogsIn(dir: string | undefined, options: { url?: string; timeoutMs?: number } = {}): Catalogs {
  const builtAt = getBuiltinModelDataGeneratedAt();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const fetched: ModelsStore = dir === undefined ? new InMemoryModelsStore() : providerFiles(join(dir, "providers"));
  const publishedPath = dir === undefined ? undefined : join(dir, "published.json");
  let inMemory: Published | undefined;
  let listed: Record<string, readonly AnyModel[]> = {};

  const show = (kept: Published | undefined) => {
    listed = kept && (builtAt === undefined || kept.lastModified > builtAt) ? kept.models : {};
  };
  const keep = (published: Published) => {
    if (publishedPath === undefined) inMemory = published;
    // Shared writers: a serve and an `invoke` may refresh at once, and either whole catalog is a good one.
    else writeFileAtomic(publishedPath, JSON.stringify(published), undefined, true);
  };

  async function refreshPublished(network: boolean, force: boolean, signal: AbortSignal): Promise<void> {
    const piAi = piAiVersion();
    const found = publishedPath === undefined ? inMemory : readJson<Published>(publishedPath);
    const kept = found?.piAi === piAi ? found : undefined;
    show(kept);
    if (!network || (!force && kept && Date.now() - kept.checkedAt < FRESH_MS)) return;
    try {
      await askPublished(piAi, kept, signal);
    } catch (error) {
      // A failed ask counts as one: the catalog kept stays, and is not asked for again for FRESH_MS. With none kept,
      // the next open asks, since a default model may need it.
      if (kept) keep({ ...kept, checkedAt: Date.now() });
      throw error;
    }
  }

  async function askPublished(piAi: string, kept: Published | undefined, signal: AbortSignal): Promise<void> {
    const url = new URL(options.url ?? PUBLISHED_URL);
    url.searchParams.set("types", MODEL_TYPES.join(","));
    url.searchParams.set("pi-version", piAi);
    const validator = kept?.etag;
    const response = await fetch(url, {
      headers: { accept: "application/json", ...(validator === undefined ? {} : { "if-none-match": validator }) },
      signal,
    });
    if (response.status === 304 && kept) {
      keep({ ...kept, checkedAt: Date.now() });
      return;
    }
    if (response.status === 404 || response.status === 501) {
      // pi.dev publishes no catalog for this pi-ai, so its own lists are the current ones.
      const none: Published = { piAi, models: {}, lastModified: 0, checkedAt: Date.now() };
      keep(none);
      show(none);
      return;
    }
    if (!response.ok) throw new Error(`${url.origin} answered ${response.status}`);
    const needs = response.headers.get("x-pi-model-catalog-minimum-version");
    if (needs !== null && olderThan(piAi, needs)) {
      throw new Error(`${url.origin} answered a catalog for pi-ai ${needs} or later, and this is ${piAi}`);
    }
    const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
    const etag = response.headers.get("etag");
    const published: Published = {
      piAi,
      models: parseCatalog(await response.json()),
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
      ...(etag === null ? {} : { etag }),
      checkedAt: Date.now(),
    };
    keep(published);
    show(published);
  }

  return {
    over(provider) {
      if (provider.refreshModels !== undefined) return provider;
      const added = () => listed[provider.id] ?? [];
      return {
        ...provider,
        getModels: () =>
          merged(
            provider.getModels(),
            added().filter((model) => isModelType(model, "chat")),
          ),
        getAllModels: () => merged(provider.getAllModels?.() ?? provider.getModels(), added()),
      } as Provider;
    },
    fetched,
    async refresh(models, { force = false } = {}) {
      const offline = process.env[OFFLINE_VARIABLE] === "1";
      const signal = AbortSignal.timeout(timeoutMs);
      const why = (error: unknown) =>
        signal.aborted ? `no answer within ${timeoutMs / 1000}s` : messageOf(error as Error);
      const [published, own] = await Promise.all([
        refreshPublished(!offline, force, signal).then(
          () => undefined,
          (error: unknown) => `pi's published catalog: ${why(error)}`,
        ),
        refreshOwn(models, !offline, force, signal),
      ]);
      const problems = [
        ...(offline && force ? [`${OFFLINE_VARIABLE}=1 is set`] : []),
        ...(published === undefined ? [] : [published]),
        ...[...own.errors].map(([provider, error]) => `${provider}: ${messageOf(error)}`),
        ...(own.aborted ? [`the providers that fetch their own: ${why(undefined)}`] : []),
      ];
      if (problems.length === 0) return undefined;
      const skip = offline ? "" : `; ${OFFLINE_VARIABLE}=1 skips the refresh`;
      return `model lists not refreshed (${problems.join("; ")}): each lists what it last had${skip}`;
    },
  };

  /**
   * The providers that fetch their own list, each asked only once what it last fetched is {@link FRESH_MS} old: pi-ai
   * asks every one of them each refresh it allows the network, and keeps when it last did beside the list.
   */
  async function refreshOwn(
    models: Models,
    network: boolean,
    force: boolean,
    signal: AbortSignal,
  ): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }> {
    // An entry it cannot read counts as none: pi-ai's refresh reads it again, and reports why it could not.
    const keptOf = (id: string) =>
      fetched.read(id).then(
        (entry) => entry,
        () => undefined,
      );
    const own = models.getProviders().filter((provider) => provider.refreshModels !== undefined);
    const stale = new Map<string, ModelsStoreEntry | undefined>();
    const fresh: string[] = [];
    for (const { id } of own) {
      const kept = await keptOf(id);
      const checkedAt = kept?.checkedAt;
      if (force || checkedAt === undefined || Date.now() - checkedAt >= FRESH_MS) stale.set(id, kept);
      else fresh.push(id);
    }
    const [restored, asked] = await Promise.all([
      models.refresh({ allowNetwork: false, providers: fresh, signal }),
      models.refresh({ allowNetwork: network, providers: [...stale.keys()], force, signal }),
    ]);
    // A failed ask counts as one, as for the published catalog: pi-ai replaces an entry only when it fetched a list, so
    // one it left as it was is a list asked for and kept, not asked for again for FRESH_MS.
    const unwritten = new Map<string, Error>();
    for (const [id, kept] of network ? stale : []) {
      if (kept === undefined || (await keptOf(id))?.checkedAt !== kept.checkedAt) continue;
      await fetched
        .write(id, { ...kept, checkedAt: Date.now() })
        .catch((error: Error) => void unwritten.set(id, error));
    }
    return {
      aborted: restored.aborted || asked.aborted,
      errors: new Map([...restored.errors, ...asked.errors, ...unwritten]),
    };
  }
}

/** The pi-ai this process runs, from its own package.json, which its exports do not reach. */
function piAiVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
  for (;;) {
    const pkg = readJson<{ name?: unknown; version?: unknown }>(join(dir, "package.json"));
    if (pkg?.name === "@earendil-works/pi-ai" && typeof pkg.version === "string") return pkg.version;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no package.json of @earendil-works/pi-ai above its entry");
    dir = parent;
  }
}

/** Whether release `version` is older than `than`, by `major.minor.patch`. */
function olderThan(version: string, than: string): boolean {
  const parts = (release: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(release);
    if (match === null) throw new Error(`"${release}" is not a version`);
    return match.slice(1).map(Number);
  };
  const [ours, theirs] = [parts(version), parts(than)];
  for (const [index, part] of ours.entries()) {
    const other = theirs[index] as number;
    if (part !== other) return part < other;
  }
  return false;
}

/** Published models override built-in ones of the same type and id, as in pi. */
function merged(builtIn: readonly AnyModel[], published: readonly AnyModel[]): never {
  const byKey = new Map<string, AnyModel>();
  for (const model of [...builtIn, ...published]) byKey.set(`${getModelType(model)}\0${model.id}`, model);
  return [...byKey.values()] as never;
}

/** pi.dev's answer: each provider's models, as a list (with `types`) or keyed by id (without). */
function parseCatalog(value: unknown): Record<string, AnyModel[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the answer is not a model catalog");
  }
  const catalog: Record<string, AnyModel[]> = {};
  for (const [provider, models] of Object.entries(value)) {
    const entries: unknown[] = Array.isArray(models) ? models : typeof models === "object" ? Object.values(models) : [];
    catalog[provider] = entries
      .filter(
        (entry): entry is AnyModel =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          [undefined, ...MODEL_TYPES].includes((entry as { type?: string }).type),
      )
      .map((model) => ({ ...model, provider }));
  }
  return catalog;
}

/** One file per provider: each is written by its own refresh, so none waits on another's lock. */
function providerFiles(dir: string): ModelsStore {
  const path = (providerId: string) => join(dir, `${encodeURIComponent(providerId)}.json`);
  return {
    read: async (providerId) => readJson<ModelsStoreEntry>(path(providerId)),
    write: async (providerId, entry) => writeFileAtomic(path(providerId), JSON.stringify(entry), undefined, true),
    delete: async (providerId) => rmSync(path(providerId), { force: true }),
  };
}

function readJson<T>(path: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} is not JSON: delete it, and the next refresh fetches it again`);
  }
}

/** pi-ai and `fetch` put the reason in the cause ("fetch failed", "Model refresh failed for radius"). */
function messageOf(error: Error): string {
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}
