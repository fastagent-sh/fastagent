/**
 * `fastagent login <provider> --check`: report whether a provider (or `provider/modelId`) is ready locally or on a
 * remote instance (`--url` / `--remote`): prints `ready`, `not_ready`, or `invalid` (or JSON with `--json`) and exits
 * 0, 1, or 2.
 */
import { definedValues } from "../../declared-secrets.ts";
import type { Provider } from "@earendil-works/pi-ai";
import { enterAgentEnv } from "../../env.ts";
import { type ModelEnvironment, modelEnvironment } from "../../harnesses/models/environment.ts";
import { providerOf } from "../../harnesses/models/models.ts";
import { definitionProviders } from "../../harnesses/assembly.ts";
import { installProxyFetch } from "../../proxy.ts";
import type { RemoteTargetFlags } from "../deployment.ts";
import { failStartup, failUsage, optionalAgentDirOrExit } from "../fail.ts";
import type { InstanceFlags } from "../instance.ts";
import { resolveRemoteAuthTarget, runRemoteLoginCheck } from "../remote-login.ts";

type AuthCheck =
  | { status: "ready"; provider: string; authType: "oauth" | "api_key"; source: string; path?: string }
  | {
      status: "not_ready";
      provider: string;
      reason: "provider_not_found" | "credentials_not_configured";
      path?: string;
    }
  | { status: "invalid"; provider: string; reason: "invalid_state"; error: string; path?: string };

const EXIT_CODES = { ready: 0, not_ready: 1, invalid: 2 } as const;

export async function runLoginCheck(
  target: string | undefined,
  opts: RemoteTargetFlags & { global?: boolean; json?: boolean; instance?: InstanceFlags },
) {
  const remoteTarget = await resolveRemoteAuthTarget(opts);
  if (remoteTarget !== undefined) {
    await runRemoteLoginCheck(remoteTarget.agent, remoteTarget.auth, remoteTarget.label, target, {
      ...(opts.json === undefined ? {} : { json: opts.json }),
      ...(opts.url === undefined ? {} : { url: opts.url }),
      ...(opts.remote === undefined ? {} : { remote: opts.remote }),
    });
    return;
  }
  if (target === undefined) failUsage("login --check needs a provider id, or a provider/modelId");
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(process.cwd());
  let providers: Provider[] = [];
  if (agentDir) {
    enterAgentEnv(agentDir);
    providers = await definitionProviders(agentDir, process.env).catch(failStartup);
  } else {
    installProxyFetch();
  }
  const environment = await modelEnvironment(agentDir, {}, providers, { environment: definedValues(process.env) });
  let provider = target;
  let modelId: string | undefined;
  if (target.includes("/")) {
    provider = providerOf(target);
    modelId = target.slice(provider.length + 1);
    if (modelId === "" || environment.models.getModel(provider, modelId) === undefined) {
      failUsage(`unknown model "${target}": \`fastagent models\` lists the ones there are`);
    }
  }
  const result = await check(environment, provider, modelId);
  console.log(opts.json ? JSON.stringify(result) : result.status);
  process.exitCode = EXIT_CODES[result.status];
}

async function check(environment: ModelEnvironment, provider: string, modelId?: string): Promise<AuthCheck> {
  if (environment.models.getProvider(provider) === undefined) {
    return { status: "not_ready", provider, reason: "provider_not_found" };
  }
  const held = await environment.authStatus(provider, modelId);
  const path = held.path === undefined ? {} : { path: held.path };
  if (held.error !== undefined)
    return { status: "invalid", provider, reason: "invalid_state", error: held.error, ...path };
  if (held.source === undefined)
    return { status: "not_ready", provider, reason: "credentials_not_configured", ...path };
  const authType = held.source === "OAuth" ? "oauth" : "api_key";
  return { status: "ready", provider, authType, source: held.source, ...path };
}
