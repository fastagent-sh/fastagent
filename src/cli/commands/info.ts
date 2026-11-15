/** `fastagent info [agent] [--json]`: print what the directory builds into, WITHOUT opening or serving the agent. */
import { definedValues } from "../../declared-secrets.ts";
import { resolve } from "node:path";
import { channelIngress } from "../../channels/discover.ts";
import { describeSecrets, missingSecrets } from "../../declared-secrets.ts";
import { enteredInstanceName, instanceName } from "../../instance-name.ts";
import { type InstanceFlags, enterInstance } from "../instance.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { agentPresentation } from "../../harnesses/pi-durable/config.ts";
import { definitionSecrets } from "../../harnesses/pi-durable/definition.ts";
import { buildDefinition, loadSourceDefinition, modelSpecFor } from "../../harnesses/pi-durable/open.ts";
import { readCommands } from "../../harnesses/pi-durable/text.ts";
import { inspectMcp } from "../../mcp/host.ts";
import { resolveStateRoot, resolveWorkdir } from "../../paths.ts";
import { nextRun } from "../../schedule/cron.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

export interface InfoOptions {
  json?: boolean;
  model?: string;
  instance?: InstanceFlags;
}

export async function runInfo(dirArg: string, opts: InfoOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  enterInstance(agentDir, opts.instance); // code may read its secrets, and fetch, when it is built
  const workdir = resolveWorkdir(agentDir);
  const definition = await loadSourceDefinition(agentDir).catch(failStartup);
  const { config } = definition;
  const name = instanceName(definition.name, enteredInstanceName());
  const presentation = agentPresentation(definition);
  const program = presentation.agent;
  const modelSpec = modelSpecFor(config, opts.model);
  const declared = (() => {
    try {
      return definitionSecrets(definition);
    } catch (error) {
      return failStartup(error);
    }
  })();
  const unsetSecrets = missingSecrets(declared, process.env);
  // Built only when every required secret has a value: building is what reads them. A module that is not what its
  // directory holds is said as the refusal `dev` and `start` would stop on.
  const code =
    unsetSecrets.length === 0
      ? await Promise.resolve()
          .then(() => buildDefinition(definition, process.env))
          .catch(failStartup)
      : undefined;
  const models = await modelEnvironment(agentDir, {}, code?.providers ?? [], {
    environment: definedValues(process.env),
  });
  const slash = modelSpec?.indexOf("/") ?? -1;
  const modelError =
    modelSpec === undefined || models.models.getModel(modelSpec.slice(0, slash), modelSpec.slice(slash + 1))
      ? undefined
      : `no provider "${modelSpec.slice(0, Math.max(slash, 0))}" offers "${modelSpec.slice(slash + 1)}"`;
  const channels = [...(code?.channels ?? new Map())].map(([name, module]) => ({
    name,
    ingress: channelIngress(module),
  }));
  const schedules = (code?.schedules ?? []).map((s) => ({
    name: s.name,
    cron: s.cron,
    tz: s.tz ?? null,
    next: nextRun(s.cron, s.tz, new Date())?.toISOString() ?? null,
  }));
  const commands = readCommands(agentDir).map(({ name, description }) => ({ name, description: description ?? null }));
  const stateRoot = resolveStateRoot(agentDir);
  const auth = models.auth;
  const mcp = await inspectMcp(agentDir).catch(failStartup);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          agentDir,
          name: name,
          agent: { name: program.name, description: program.description ?? null },
          starters: presentation.starters ?? [],
          model: modelSpec ?? null,
          modelError: modelError ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          tools: code?.tools.map(({ name }) => name) ?? null,
          mcp,
          extensions: code?.extensions.map(({ name }) => name) ?? null,
          channels: code === undefined ? null : channels,
          schedules: code === undefined ? null : schedules,
          commands,
          secrets: definition.inputs.secrets,
          unsetSecrets: unsetSecrets.map(({ name }) => name),
          workdir,
          stateRoot,
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
  line("model", modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or model in fastagent.config.ts)");
  if (modelError) cont(`⚠ does not resolve: ${modelError}`);
  if (config.thinkingLevel) line("thinking", config.thinkingLevel);
  const unbuilt = "(not built: a required secret has no value)";
  line("tools", code ? code.tools.map(({ name }) => name).join(", ") || "(none)" : unbuilt);
  if (code && code.extensions.length > 0) line("extensions", code.extensions.map(({ name }) => name).join(", "));
  line(
    "mcp",
    mcp.map((server) => `${server.name} (${server.transport}, ${server.authorization})`).join(", ") || "(none)",
  );
  line("channels", code ? channels.map((c) => `${c.name} (${c.ingress})`).join(", ") || "(none)" : unbuilt);
  line(
    "schedules",
    code ? schedules.map((s) => `${s.name} (next ${s.next ?? "never"})`).join(", ") || "(none)" : unbuilt,
  );
  line("commands", commands.map(({ name }) => `/${name}`).join(", ") || "(none)");
  line("secrets", declared.length > 0 ? describeSecrets(declared) : "(none declared)");
  if (unsetSecrets.length > 0) {
    cont(`⚠ dev, start and deployments refuse to boot until set: ${unsetSecrets.map((s) => s.name).join(", ")}`);
  }
  line("workdir", workdir);
  line("state", stateRoot);
  if (auth) line("auth", auth.fallback === undefined ? auth.path : `${auth.path} (then ${auth.fallback})`);
}
