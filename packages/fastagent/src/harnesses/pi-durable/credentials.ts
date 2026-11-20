/**
 * Instance-durable model credentials in pi-durable's Session storage (SQLite, PostgreSQL, or Aurora DSQL), so OAuth
 * logins, refreshed tokens, and installation device IDs survive container restarts and scale-to-zero microVMs.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { type JsonObject, type Session, defineDoc } from "@earendil-works/pi-durable";

const whole = () => true;

const CredentialsDoc = defineDoc<{ credentials: Record<string, JsonObject> }>({
  kind: "fastagent.credentials",
  version: 1,
  scope: "session",
  initial: () => ({ credentials: {} }),
  checkpointWhen: whole,
});

const DeviceIdDoc = defineDoc<{ deviceId: string }>({
  kind: "fastagent.device-id",
  version: 1,
  scope: "session",
  initial: () => ({ deviceId: "" }),
  checkpointWhen: whole,
});

export type CredentialSession = Pick<Session, "commit" | "snapshot">;

export interface DurableCredentialStore extends CredentialStore {
  /** Stable installation identity for OAuth providers that require one, persisted in instance storage. */
  getOrCreateDeviceId(): Promise<string>;
}

function validCredential(value: unknown): Credential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const type = (value as { type?: unknown }).type;
  return type === "oauth" || type === "api_key" ? (value as Credential) : undefined;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A read-write `CredentialStore` backed by `CredentialsDoc` in `session`. Per-provider `modify` calls are serialized
 * in memory while keeping async provider refreshes outside the database commit.
 */
export function durableCredentialStore(session: CredentialSession, context: Context): DurableCredentialStore {
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(providerId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(providerId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tracked = run.finally(() => {
      if (queues.get(providerId) === tracked) queues.delete(providerId);
    });
    queues.set(providerId, tracked);
    return run;
  };

  const readAll = async (): Promise<Record<string, JsonObject>> =>
    clone((await session.snapshot(CredentialsDoc, context))?.credentials ?? {});

  return {
    async read(providerId) {
      const all = await readAll();
      return validCredential(all[providerId]);
    },
    async list() {
      const all = await readAll();
      const infos: CredentialInfo[] = [];
      for (const [providerId, raw] of Object.entries(all)) {
        const cred = validCredential(raw);
        if (cred !== undefined) infos.push({ providerId, type: cred.type });
      }
      return infos;
    },
    modify(providerId, fn) {
      return serialized(providerId, async () => {
        const current = validCredential((await readAll())[providerId]);
        const next = await fn(current);
        if (next === undefined) return current;
        const stored = clone(next) as unknown as JsonObject;
        await session.commit(async (tx) => {
          const doc = await tx.doc(CredentialsDoc);
          doc.credentials = { ...clone(doc.credentials), [providerId]: stored };
        }, context);
        return next;
      });
    },
    async delete(providerId) {
      await serialized(providerId, async () => {
        const all = await readAll();
        if (!(providerId in all)) return;
        await session.commit(async (tx) => {
          const doc = await tx.doc(CredentialsDoc);
          if (!(providerId in doc.credentials)) return;
          const next = clone(doc.credentials);
          delete next[providerId];
          doc.credentials = next;
        }, context);
      });
    },
    async getOrCreateDeviceId() {
      const existing = (await session.snapshot(DeviceIdDoc, context))?.deviceId;
      if (typeof existing === "string" && existing !== "") return existing;
      const generated = randomUUID();
      return session.commit(async (tx) => {
        const doc = await tx.doc(DeviceIdDoc);
        if (typeof doc.deviceId === "string" && doc.deviceId !== "") return doc.deviceId;
        doc.deviceId = generated;
        return generated;
      }, context);
    },
  };
}

/**
 * Layer a late-bound primary `CredentialStore` (instance durable storage) over an optional fallback store (local file
 * layers). Reads prefer `primary`; refreshes write back to whichever store holds the credential.
 */
export function overlayCredentialStore(
  primary: () => CredentialStore | undefined,
  fallback?: CredentialStore,
): CredentialStore {
  return {
    async read(providerId) {
      const found = await primary()?.read(providerId);
      if (found !== undefined) return found;
      return fallback?.read(providerId);
    },
    async list() {
      const infos = new Map<string, CredentialInfo>();
      for (const info of (await fallback?.list()) ?? []) infos.set(info.providerId, info);
      for (const info of (await primary()?.list()) ?? []) infos.set(info.providerId, info);
      return [...infos.values()];
    },
    async modify(providerId, fn) {
      const first = primary();
      if (first !== undefined) {
        const inPrimary = (await first.read(providerId)) !== undefined;
        if (inPrimary || fallback === undefined || (await fallback.read(providerId)) === undefined) {
          return first.modify(providerId, fn);
        }
      }
      if (fallback !== undefined) return fallback.modify(providerId, fn);
      return fn(undefined);
    },
    async delete(providerId) {
      const first = primary();
      if (first !== undefined && (await first.read(providerId)) !== undefined) {
        await first.delete(providerId);
        return;
      }
      await fallback?.delete(providerId);
    },
  };
}
