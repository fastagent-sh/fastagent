/**
 * `fastagent info [--json]`: print what the directory builds into, WITHOUT opening or serving the agent: it
 * reads the directory and the environment, never the instance's storage, so it answers beside a running serve.
 */
import { parseModelRef } from "@fastagent-sh/client/agent-api";
import { definedValues } from "../../declared-secrets.ts";
import { resolve } from "node:path";
import { describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import { enteredInstanceName, instanceName } from "../../instance-name.ts";
import { type InstanceFlags, enterInstance } from "../instance.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import {
  agentPresentation,
  diagnoseHarnessCompatibility,
  resolveCodingTools,
  resolveHarnessSelection,
} from "../../harnesses/config.ts";
import { definitionSecrets } from "../../definition/definition.ts";
import { buildDefinition, loadSourceDefinition, modelSpecFor } from "../../harnesses/assembly.ts";
import { describeInstanceStorage, resolveHarnessProvider } from "../../harnesses/serving.ts";
import { readCommands } from "../../harnesses/text.ts";
import { declareMcp } from "../../mcp/config.ts";
import * as Redacted from "effect/Redacted";
import { DATABASE_URL_ENV, resolveStateRoot, resolveWorkdir } from "../../paths.ts";
import { readDatabaseUrlEnv, readProcessEnv } from "../../process-env.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";

export interface InfoOptions {
  json?: boolean;
  model?: string;
  harness?: string;
  sandbox?: string;
  instance?: InstanceFlags;
}

export async function runInfo(dirArg: string, opts: InfoOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const instance = enterInstance(agentDir, opts.instance); // code may read its secrets, and fetch, when it is built
  const configEnv = instance.configEnv;
  const hostEnv = readProcessEnv();
  const workdir = resolveWorkdir(agentDir, configEnv);
  const definition = await loadSourceDefinition(agentDir).catch(failStartup);
  const { config } = definition;
  const rawSelection = (() => {
    try {
      return resolveHarnessSelection(
        config,
        {
          ...(opts.harness === undefined ? {} : { harness: opts.harness }),
          ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
        },
        configEnv,
      );
    } catch (error) {
      return failUsage(error instanceof Error ? error.message : String(error));
    }
  })();
  const resolvedProvider =
    rawSelection.harness === "pi-durable"
      ? undefined
      : await resolveHarnessProvider(rawSelection.harness, agentDir).catch((error: unknown) =>
          opts.harness !== undefined
            ? failUsage(error instanceof Error ? error.message : String(error))
            : failStartup(error),
        );
  const harnessSelection = (() => {
    if (resolvedProvider === undefined) return rawSelection;
    if (rawSelection.sandbox !== undefined && resolvedProvider.supportsSandbox !== true) {
      const message = `sandbox (${JSON.stringify(rawSelection.sandbox)}) is not supported by harness "${resolvedProvider.name}"`;
      return opts.sandbox !== undefined ? failUsage(message) : failStartup(new Error(message));
    }
    if (rawSelection.sandbox === undefined && resolvedProvider.supportsSandbox === true) {
      return { harness: resolvedProvider.name, sandbox: "workspace" as const };
    }
    return rawSelection;
  })();
  const entered = instance.name ?? enteredInstanceName(configEnv);
  const name = instanceName(definition.name, entered);
  const presentation = agentPresentation(definition);
  const program = presentation.agent;
  const modelSpec = modelSpecFor(config, opts.model, configEnv);
  const declared = (() => {
    try {
      return definitionSecrets(definition);
    } catch (error) {
      return failStartup(error);
    }
  })();
  const unsetSecrets = missingSecrets(declared, hostEnv);
  // Built only when every required secret has a value: building is what reads them. A module that is not what its
  // directory holds is said as the refusal `dev` and `start` would stop on.
  const code =
    unsetSecrets.length === 0
      ? await Promise.resolve()
          .then(() => buildDefinition(definition, hostEnv))
          .catch(failStartup)
      : undefined;
  const models = await modelEnvironment(agentDir, {}, code?.providers ?? [], {
    environment: definedValues(hostEnv),
  });
  const parsedModel = modelSpec === undefined ? undefined : parseModelRef(modelSpec);
  const modelError =
    modelSpec === undefined ||
    (parsedModel !== undefined && models.models.getModel(parsedModel.provider, parsedModel.modelId) !== undefined)
      ? undefined
      : parsedModel === undefined
        ? `invalid model "${modelSpec}": expected "provider/modelId"`
        : `no provider "${parsedModel.provider}" offers "${parsedModel.modelId}"`;
  const stateRoot = resolveStateRoot(agentDir, configEnv);
  const databaseUrl = readDatabaseUrlEnv();
  const storageEnv: Readonly<Record<string, string | undefined>> =
    databaseUrl === undefined ? configEnv : { ...configEnv, [DATABASE_URL_ENV]: Redacted.value(databaseUrl) };
  const storagePlace = { stateRoot, env: storageEnv, ...(entered === undefined ? {} : { name: entered }) };
  const codingTools = [...resolveCodingTools(config.codingTools)];
  const commands = readCommands(agentDir).map(({ name, description }) => ({ name, description: description ?? null }));
  const auth = models.auth;
  const mcp = declareMcp(config.mcpServers, definition.dir).map(({ name, server }) => ({
    name,
    transport: server.type ?? "stdio",
    ...(server.type === "http" ? { url: server.url } : {}),
  }));
  const warnings = [
    ...diagnoseHarnessCompatibility(definition, harnessSelection, {
      ...(code === undefined ? {} : { extensions: code.extensions }),
      ...(resolvedProvider?.supportsExtensions === undefined
        ? {}
        : { supportsExtensions: resolvedProvider.supportsExtensions }),
    }),
  ];

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          agentDir,
          name: name,
          agent: { name: program.name, description: program.description ?? null },
          starters: presentation.starters ?? [],
          harness: harnessSelection.harness,
          sandbox: harnessSelection.sandbox ?? null,
          model: modelSpec ?? null,
          modelError: modelError ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          maxSteps: config.maxSteps ?? null,
          codingTools,
          tools: code?.tools.map(({ name }) => name) ?? null,
          mcp,
          extensions: code?.extensions.map(({ name }) => name) ?? null,
          commands,
          warnings,
          secrets: definition.inputs.secrets,
          unsetSecrets: unsetSecrets.map(({ name }) => name),
          workdir,
          stateRoot,
          storage: describeInstanceStorage(storagePlace),
          authPath: auth?.path ?? null,
          fallbackAuthPath: auth?.fallback ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  const line = (label: string, value: string): void => console.log(`${`${label}:`.padEnd(13)} ${value}`);
  /** A continuation under the previous line, aligned to the same column (no label, so no bare colon). */
  const cont = (value: string): void => console.log(`${"".padEnd(13)} ${value}`);
  line("agent", `${name} — ${agentDir}`);
  if (program.name !== name || program.description !== undefined) {
    line("program", `${program.name}${program.description === undefined ? "" : ` — ${program.description}`}`);
  }
  if (presentation.starters !== undefined)
    line("starters", presentation.starters.map((starter) => JSON.stringify(starter)).join(", "));
  line(
    "harness",
    harnessSelection.sandbox !== undefined
      ? `${harnessSelection.harness} (sandbox: ${harnessSelection.sandbox})`
      : harnessSelection.harness,
  );
  for (const warning of warnings) cont(`⚠ ${warning}`);
  line("model", modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or model in fastagent.config.ts)");
  if (modelError) cont(`⚠ does not resolve: ${modelError}`);
  if (config.thinkingLevel) line("thinking", config.thinkingLevel);
  if (config.maxSteps !== undefined) line("max steps", String(config.maxSteps));
  const unbuilt = "(not built: a required secret has no value)";
  line("coding tools", codingTools.join(", ") || "(none)");
  line("tools", code ? code.tools.map(({ name }) => name).join(", ") || "(none)" : unbuilt);
  if (code && code.extensions.length > 0) line("extensions", code.extensions.map(({ name }) => name).join(", "));
  line("mcp", mcp.map((server) => `${server.name} (${server.transport})`).join(", ") || "(none)");
  line("commands", commands.map(({ name }) => `/${name}`).join(", ") || "(none)");
  line("secrets", declared.length > 0 ? describeSecrets(declared) : "(none declared)");
  if (unsetSecrets.length > 0) {
    cont(`⚠ dev, start and deployments refuse to boot until set: ${unsetSecrets.map((s) => s.name).join(", ")}`);
  }
  line("workdir", workdir);
  line("state", stateRoot);
  line("storage", describeInstanceStorage(storagePlace));
  if (auth) line("auth", auth.fallback === undefined ? auth.path : `${auth.path} (then ${auth.fallback})`);
}
