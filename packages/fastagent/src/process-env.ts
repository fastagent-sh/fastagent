/**
 * The single approved `process.env` boundary for `@fastagent-sh/fastagent`.
 * Keeps non-secret control-plane config separate from `Redacted` credentials (`FASTAGENT_API_KEY`,
 * `FASTAGENT_DATABASE_URL`), and isolates the two explicit process-level writes (`.env` loading and the
 * cross-package `FASTAGENT_DEV` serve marker).
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** A read-only snapshot of the current process environment (for agent secret/baseEnv boundaries only). */
export function readProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function decodeRecordConfig<A>(config: Config.Config<A>, record: Record<string, string | undefined>): A {
  const provider = ConfigProvider.fromEnvRecord(record, { preserveEmptyStrings: true });
  return Effect.runSync(config.parse(provider));
}

/** Read one optional environment variable at the boundary without per-call ConfigProvider allocation. */
export function readOptionalEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return env[name];
}

const ControlPlaneEnvConfig = Config.all({
  devWorker: Config.option(Config.String("FASTAGENT_DEV_WORKER")),
  port: Config.option(Config.String("PORT")),
  instanceRoot: Config.option(Config.String("FASTAGENT_ROOT")),
  instanceName: Config.option(Config.String("FASTAGENT_NAME")),
  model: Config.option(Config.String("FASTAGENT_MODEL")),
  harness: Config.option(Config.String("FASTAGENT_HARNESS")),
  sandbox: Config.option(Config.String("FASTAGENT_SANDBOX")),
  deployed: Config.option(Config.String("FASTAGENT_DEPLOYED")),
  dev: Config.option(Config.String("FASTAGENT_DEV")),
});

export interface RuntimeCliEnv {
  readonly devWorker: boolean;
  readonly port: string | undefined;
  readonly instanceRoot: string | undefined;
  readonly instanceName: string | undefined;
  readonly model: string | undefined;
  readonly harness: string | undefined;
  readonly sandbox: string | undefined;
  readonly deployed: string | undefined;
  readonly dev: string | undefined;
}

/** Decode non-secret CLI control-plane variables in one boundary pass, never touching secret env vars. */
export function decodeRuntimeCliEnv(env?: Readonly<Record<string, string | undefined>>): RuntimeCliEnv {
  const record: Record<string, string | undefined> =
    env === undefined
      ? {
          FASTAGENT_DEV_WORKER: process.env.FASTAGENT_DEV_WORKER,
          PORT: process.env.PORT,
          FASTAGENT_ROOT: process.env.FASTAGENT_ROOT,
          FASTAGENT_NAME: process.env.FASTAGENT_NAME,
          FASTAGENT_MODEL: process.env.FASTAGENT_MODEL,
          FASTAGENT_HARNESS: process.env.FASTAGENT_HARNESS,
          FASTAGENT_SANDBOX: process.env.FASTAGENT_SANDBOX,
          FASTAGENT_DEPLOYED: process.env.FASTAGENT_DEPLOYED,
          FASTAGENT_DEV: process.env.FASTAGENT_DEV,
        }
      : {
          FASTAGENT_DEV_WORKER: env.FASTAGENT_DEV_WORKER,
          PORT: env.PORT,
          FASTAGENT_ROOT: env.FASTAGENT_ROOT,
          FASTAGENT_NAME: env.FASTAGENT_NAME,
          FASTAGENT_MODEL: env.FASTAGENT_MODEL,
          FASTAGENT_HARNESS: env.FASTAGENT_HARNESS,
          FASTAGENT_SANDBOX: env.FASTAGENT_SANDBOX,
          FASTAGENT_DEPLOYED: env.FASTAGENT_DEPLOYED,
          FASTAGENT_DEV: env.FASTAGENT_DEV,
        };
  const decoded = decodeRecordConfig(ControlPlaneEnvConfig, record);
  return {
    devWorker: Option.getOrUndefined(decoded.devWorker) === "1",
    port: Option.getOrUndefined(decoded.port),
    instanceRoot: Option.getOrUndefined(decoded.instanceRoot),
    instanceName: Option.getOrUndefined(decoded.instanceName),
    model: Option.getOrUndefined(decoded.model),
    harness: Option.getOrUndefined(decoded.harness),
    sandbox: Option.getOrUndefined(decoded.sandbox),
    deployed: Option.getOrUndefined(decoded.deployed),
    dev: Option.getOrUndefined(decoded.dev),
  };
}

const ApiKeyConfig = Config.option(Config.Redacted("FASTAGENT_API_KEY"));
const DatabaseUrlConfig = Config.option(Config.Redacted("FASTAGENT_DATABASE_URL"));

/** Decode `FASTAGENT_API_KEY` as `Redacted<string>` in isolation from non-secret config. */
export function readApiKeyEnv(
  env?: Readonly<Record<string, string | undefined>>,
): Redacted.Redacted<string> | undefined {
  const raw = env === undefined ? process.env.FASTAGENT_API_KEY : env.FASTAGENT_API_KEY;
  return Option.getOrUndefined(decodeRecordConfig(ApiKeyConfig, { FASTAGENT_API_KEY: raw }));
}

/** Decode `FASTAGENT_DATABASE_URL` as `Redacted<string>` in isolation from non-secret config. */
export function readDatabaseUrlEnv(
  env?: Readonly<Record<string, string | undefined>>,
): Redacted.Redacted<string> | undefined {
  const raw = env === undefined ? process.env.FASTAGENT_DATABASE_URL : env.FASTAGENT_DATABASE_URL;
  return Option.getOrUndefined(decodeRecordConfig(DatabaseUrlConfig, { FASTAGENT_DATABASE_URL: raw }));
}

/** Write parsed `.env` entries into `process.env` only when unset, unwrapping `Redacted` at the OS boundary. */
export function applyProcessEnvIfUnset(values: ReadonlyMap<string, string | Redacted.Redacted<string>>): void {
  for (const [key, raw] of values) {
    if (!(key in process.env)) {
      process.env[key] = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
    }
  }
}

/** Set or clear a single process-level marker variable (e.g. `FASTAGENT_DEV`). */
export function setProcessEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
