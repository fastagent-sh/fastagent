/**
 * `fastagent secrets list|set|push <host>`: a deployment's values on the target that keeps them (agent-artifact.md
 * §6.2). `deploy` checks names and never carries a file; these are how the values get there. A value is never an
 * argument: it is typed without echo, read from standard input, taken from a value file, or from the environment of a
 * command that injected it (`op run -- fastagent secrets push fly --from-env`).
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isCancel, password } from "@clack/prompts";
import { isEnvName } from "../../declared-secrets.ts";
import { agentcoreName, agentcoreSecretName } from "../../deploy/agentcore/plan.ts";
import { agentcoreSecretStore } from "../../deploy/agentcore/store.ts";
import { deploymentApi } from "../../deploy/api.ts";
import { fileStore } from "../../deploy/file-store.ts";
import { flyTomlFile, parseFlyAppName, toFlyAppName } from "../../deploy/fly/plan.ts";
import { flyStore } from "../../deploy/fly/store.ts";
import { toRailwayName } from "../../deploy/railway/plan.ts";
import { railwayStore } from "../../deploy/railway/store.ts";
import { preflightDeploy } from "../../deploy/preflight.ts";
import { awsRunner, spawnRunner } from "../../deploy/runner.ts";
import type { SecretStore } from "../../deploy/secret-store.ts";
import { declaredNames, hostSignedOutGate, secretNeeds } from "../../deploy/secrets.ts";
import { readInstanceConfigFile, resolveConfig } from "../../harnesses/pi-durable/config.ts";
import { loadSourceDefinition } from "../../harnesses/pi-durable/open.ts";
import { API_KEY_VARIABLE } from "../../http/server.ts";
import { readTextIfExists, selectAgentEnvironment } from "../../paths.ts";
import { unmarkDevServe } from "../../serving-command.ts";
import { dotEnvPath, loadEnvValues } from "../../value-file.ts";
import { deploymentName } from "../../deploy/deployment-name.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { printReport } from "../ticket.ts";
import { join } from "node:path";

/** The targets that keep a deployment's values in a store of their own. */
export type SecretsHost = "docker" | "fly" | "railway" | "agentcore";

export interface SecretsOptions {
  /** `--config <file>`: the instance configuration the deployment delivers; its channels decide which names it reads. */
  config?: string;
  /** `--env-file <file>` (push): where the values come from. */
  envFile?: string;
  /** `--from-env` (push): the environment this command runs in. */
  fromEnv?: boolean;
  /** `--generate` (set): a random value, printed once. */
  generate?: boolean;
  json?: boolean;
}

const LABELS: Record<SecretsHost, string> = {
  docker: "Docker",
  fly: "Fly",
  railway: "Railway",
  agentcore: "AWS Secrets Manager",
};

/** The store of `host` for the instance `name` of the agent in `agentDir`, its CLI signed in. */
async function openStore(host: SecretsHost, agentDir: string, name: string): Promise<SecretStore> {
  const log = (message: string) => console.error(`[fastagent] ${message}`);
  if (host === "docker") return fileStore(agentDir, dotEnvPath(agentDir));
  if (host === "agentcore")
    return agentcoreSecretStore(awsRunner(agentDir), agentcoreSecretName(agentcoreName(name)), log);
  if (host === "fly") {
    const fly = spawnRunner("fly", agentDir, { stdoutToStderr: true });
    if ((await fly(["version"], { capture: true })).code === 127) {
      failStartup(new Error("flyctl not found — install it: https://fly.io/docs/flyctl/install, then re-run"));
    }
    if ((await fly(["auth", "whoami"], { capture: true })).code !== 0) {
      failStartup(new Error(hostSignedOutGate("Fly", "fly auth login", "FLY_API_TOKEN", "fly auth login")));
    }
    const toml = await readTextIfExists(join(agentDir, flyTomlFile(name)));
    const app = (toml && parseFlyAppName(toml)) ?? toFlyAppName(name);
    return flyStore(fly, app, log, { stage: false });
  }
  const railway = spawnRunner("railway", agentDir, { stdoutToStderr: true });
  if ((await railway(["--version"], { capture: true })).code === 127) {
    failStartup(new Error("railway CLI not found — install it: https://docs.railway.com/guides/cli, then re-run"));
  }
  if ((await railway(["whoami"], { capture: true })).code !== 0) {
    failStartup(
      new Error(hostSignedOutGate("Railway", "railway login", "RAILWAY_API_TOKEN (an account token)", "railway login")),
    );
  }
  return railwayStore(railway, toRailwayName(name), log, { redeploy: true });
}

/** What the definition declares for the deployment, and the production value file it reads. */
async function declared(agentDir: string, configFile: string | undefined, host: SecretsHost) {
  const name = await deploymentName(agentDir, configFile);
  const instance = configFile === undefined ? undefined : await readInstanceConfigFile(resolve(configFile));
  const definition = await loadSourceDefinition(agentDir);
  const config = resolveConfig(definition, instance);
  const api = deploymentApi({ config, hostServes: host !== "agentcore" });
  const facts = await preflightDeploy({
    agentDir,
    name,
    config,
    ...(instance === undefined
      ? {}
      : { delivered: { source: instance, text: `${JSON.stringify(instance.values, null, 2)}\n` } }),
    run: false,
    force: false,
    noResidentProcess: false,
    storageResets: false,
    servesApi: api.served,
  });
  if (!facts.ok) throw new Error(facts.gate);
  return {
    needs: secretNeeds(facts.modelAuth, facts.declaredSecrets, facts.modelKey),
    names: declaredNames(facts.modelAuth, facts.declaredSecrets, facts.modelKey),
    modelKeys: facts.modelKey.variables,
    // The key of the Agent API: on the hosts that serve it.
    apiNames: api.served ? [API_KEY_VARIABLE] : [],
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array | string));
  return Buffer.concat(chunks).toString("utf8");
}

/** The value for `name`: random with `--generate`, else typed without echo at a terminal, else the whole standard input. */
async function valueFor(name: string, generate: boolean | undefined): Promise<{ value: string; minted: boolean }> {
  if (generate) return { value: randomBytes(32).toString("base64url"), minted: true };
  if (process.stdin.isTTY) {
    const typed = await password({ message: name });
    if (isCancel(typed)) throw new Error("cancelled");
    return { value: String(typed), minted: false };
  }
  return { value: (await readStdin()).replace(/\r?\n$/, ""), minted: false };
}

export async function runSecrets(
  action: "list" | "set" | "push",
  host: SecretsHost,
  name: string | undefined,
  dirArg: string,
  opts: SecretsOptions,
): Promise<void> {
  if (action === "set" && !isEnvName(name as string)) failUsage(`${name} is not an environment variable name`);
  if (action === "push" && opts.fromEnv && opts.envFile !== undefined) {
    failUsage("--env-file and --from-env are two sources: pass one");
  }
  const agentDir = agentDirOrExit(resolve(dirArg));
  // The deployment's own, never the development instance's: its channels receive the way the box will choose.
  selectAgentEnvironment("production");
  unmarkDevServe();
  try {
    const store = await openStore(host, agentDir, await deploymentName(agentDir, opts.config));
    if (action === "list") return await list(store, host, agentDir, opts);
    if (action === "set") return await set(store, host, name as string, opts, agentDir);
    return await push(store, host, agentDir, opts);
  } catch (error) {
    failStartup(error);
  }
}

/** When a written value reaches what is running: a Docker container reads its file at start, an AgentCore session its secret. */
function noteWhenItTakesEffect(host: SecretsHost): void {
  if (host === "docker") {
    console.error(
      "[fastagent] note: a running container reads it after `docker compose up -d`, or the next `deploy docker --run`",
    );
  }
  if (host === "agentcore") {
    console.error(
      "[fastagent] note: the runtime reads the secret when a session starts: a session already running keeps its values " +
        "until it ends (its idle timeout) or the next deploy",
    );
  }
}

async function list(store: SecretStore, host: SecretsHost, agentDir: string, opts: SecretsOptions): Promise<void> {
  const label = LABELS[host];
  const { needs, names, modelKeys } = await declared(agentDir, opts.config, host);
  // A target with no app yet holds nothing: every name is missing, which is an answer and not a failure.
  const present = await store.exists();
  if (!present)
    console.error(
      `[fastagent] ${label} has no app for this agent yet: the first set, push or \`deploy --run\` makes it`,
    );
  const have = present ? await store.names() : new Set<string>();
  const required = new Set(needs.map((need) => need.name));
  const rows = names.map((name) => ({
    name,
    set: have.has(name),
    required: required.has(name),
    hint:
      needs.find((need) => need.name === name)?.hint ??
      (modelKeys.includes(name) ? "your model provider key, or a login on the box" : undefined),
  }));
  printReport(
    opts.json,
    { host: label, exists: present, secrets: rows },
    rows.map(
      ({ name, set, required: must, hint }) =>
        `${set ? "set    " : "missing"}  ${name}  (${must ? (hint ?? "required") : `optional${hint === undefined ? "" : `: ${hint}`}`})`,
    ),
  );
}

async function set(
  store: SecretStore,
  host: SecretsHost,
  name: string,
  opts: SecretsOptions,
  agentDir: string,
): Promise<void> {
  const label = LABELS[host];
  const { names, apiNames } = await declared(agentDir, opts.config, host);
  if (!names.includes(name) && !apiNames.includes(name)) {
    console.error(`[fastagent] warn: ${name} is not declared by the definition, so nothing reads it on ${label}`);
  }
  const { value, minted } = await valueFor(name, opts.generate);
  if (value.trim() === "") throw new Error(`${name} would be empty`);
  await store.ensure();
  await store.write({ [name]: value });
  console.error(`[fastagent] set ${name} on ${label}`);
  noteWhenItTakesEffect(host);
  // The one time a value is shown: it was made here and nobody holds it yet.
  if (minted) console.log(value);
}

async function push(store: SecretStore, host: SecretsHost, agentDir: string, opts: SecretsOptions): Promise<void> {
  const label = LABELS[host];
  const { names, apiNames } = await declared(agentDir, opts.config, host);
  const known = new Set([...names, ...apiNames]);
  let source: ReadonlyMap<string, string>;
  let where: string;
  if (opts.fromEnv) {
    source = new Map(Object.entries(process.env).flatMap(([n, v]) => (v === undefined ? [] : [[n, v] as const])));
    where = "the environment";
  } else {
    if (host === "docker" && opts.envFile === undefined) {
      throw new Error(
        `${dotEnvPath(agentDir)} is Docker's own store, so there is nothing to push from it: pass --env-file <file> or --from-env`,
      );
    }
    const file = opts.envFile === undefined ? dotEnvPath(agentDir) : resolve(opts.envFile);
    source = loadEnvValues(file);
    where = file;
    if (source.size === 0 && opts.envFile === undefined) {
      throw new Error(`${file} holds no values: pass --env-file <file>, or --from-env for the environment`);
    }
  }
  const toWrite: Record<string, string> = {};
  for (const [n, v] of source) if (known.has(n) && v.trim() !== "") toWrite[n] = v;
  const skipped = opts.fromEnv ? [] : [...source.keys()].filter((n) => !known.has(n));
  if (skipped.length > 0) {
    console.error(`[fastagent] not pushed, since the definition does not declare them: ${skipped.join(", ")}`);
  }
  if (Object.keys(toWrite).length === 0)
    throw new Error(`${where} holds a value for none of the names the definition declares`);
  await store.ensure();
  await store.write(toWrite);
  console.error(
    `[fastagent] pushed ${Object.keys(toWrite).length} value(s) from ${where} to ${label}: ${Object.keys(toWrite).join(", ")}`,
  );
  noteWhenItTakesEffect(host);
}
