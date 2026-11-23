/**
 * The single approved `process.env` boundary for `@fastagent-sh/fastagent`.
 * Decodes host environment variables via Effect `Config` + `Redacted`, and isolates the two explicit
 * process-level writes (`.env` loading and the cross-package `FASTAGENT_DEV` serve marker).
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** A read-only snapshot of the current process environment. */
export function readProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/** Decode an Effect `Config` against `env` (defaulting to the host `process.env`), preserving empty strings. */
function decodeEnvConfig<A>(
  config: Config.Config<A>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): A {
  const provider = ConfigProvider.fromEnvRecord(env as Record<string, string | undefined>, {
    preserveEmptyStrings: true,
  });
  return Effect.runSync(config.parse(provider));
}

/** Read one optional environment variable via Effect `Config`. */
export function readOptionalEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return Option.getOrUndefined(decodeEnvConfig(Config.option(Config.String(name)), env));
}

const RuntimeCliEnvConfig = Config.all({
  devWorker: Config.option(Config.String("FASTAGENT_DEV_WORKER")),
  port: Config.option(Config.String("PORT")),
  apiKey: Config.option(Config.Redacted("FASTAGENT_API_KEY")),
  instanceRoot: Config.option(Config.String("FASTAGENT_ROOT")),
  instanceName: Config.option(Config.String("FASTAGENT_NAME")),
  databaseUrl: Config.option(Config.String("FASTAGENT_DATABASE_URL")),
});

export interface RuntimeCliEnv {
  readonly devWorker: boolean;
  readonly port: string | undefined;
  readonly apiKey: Redacted.Redacted<string> | undefined;
  readonly instanceRoot: string | undefined;
  readonly instanceName: string | undefined;
  readonly databaseUrl: string | undefined;
}

/** Decode the CLI runtime's own control-plane environment variables in one boundary pass. */
export function decodeRuntimeCliEnv(env: Readonly<Record<string, string | undefined>> = process.env): RuntimeCliEnv {
  const decoded = decodeEnvConfig(RuntimeCliEnvConfig, env);
  return {
    devWorker: Option.getOrUndefined(decoded.devWorker) === "1",
    port: Option.getOrUndefined(decoded.port),
    apiKey: Option.getOrUndefined(decoded.apiKey),
    instanceRoot: Option.getOrUndefined(decoded.instanceRoot),
    instanceName: Option.getOrUndefined(decoded.instanceName),
    databaseUrl: Option.getOrUndefined(decoded.databaseUrl),
  };
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
