/**
 * `fastagent auth check`: whether a provider is ready for the agent here, as pi's `auth check` answers it, for a script
 * or a coding agent: `ready`, `not_ready` or `invalid` on stdout, exit 0, 1 or 2. The answer is the one the agent's
 * messages would get (`ModelEnvironment.authStatus`, a due refresh included).
 */
import type { Provider } from "@earendil-works/pi-ai";
import { enterAgentEnv } from "../../env.ts";
import { type ModelEnvironment, modelEnvironment } from "../../harnesses/models/environment.ts";
import { providerOf } from "../../harnesses/models/models.ts";
import { definitionProviders } from "../../harnesses/pi-durable/open.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup, failUsage, optionalAgentDirOrExit } from "../fail.ts";

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

export async function runAuthCheck(opts: { provider?: string; model?: string; global?: boolean; json?: boolean }) {
  if (opts.provider === undefined && opts.model === undefined) {
    failUsage("auth check needs --provider <id> or --model <provider/modelId>");
  }
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(process.cwd());
  let providers: Provider[] = [];
  if (agentDir) {
    enterAgentEnv(agentDir);
    providers = await definitionProviders(agentDir).catch(failStartup);
  } else {
    installProxyFetch();
  }
  const environment = await modelEnvironment(agentDir, {}, providers);
  let provider = opts.provider;
  let modelId: string | undefined;
  if (opts.model !== undefined) {
    const ofModel = providerOf(opts.model);
    modelId = opts.model.slice(ofModel.length + 1);
    if (modelId === "" || environment.models.getModel(ofModel, modelId) === undefined) {
      failUsage(`unknown model "${opts.model}": \`fastagent models\` lists the ones there are`);
    }
    if (provider !== undefined && provider !== ofModel) failUsage(`${opts.model} is not a model of ${provider}`);
    provider = ofModel;
  }
  const result = await check(environment, provider as string, modelId);
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
