/**
 * `fastagent logout [provider]`: remove a stored credential for a provider locally (`.secrets/auth.json`), globally
 * (`-g` or outside an agent), or from a remote instance's durable storage (`--url` / `--remote`). Environment
 * variables and provider-side grants are left unchanged.
 */
import { enterAgentEnv } from "../../env.ts";
import { GLOBAL_AUTH_PATH, fastagentCredentialStore, resolveAuthPath } from "../../harnesses/models/credentials.ts";
import { loginProviders } from "../../harnesses/models/models.ts";
import { definitionProviders } from "../../harnesses/assembly.ts";
import { globalHome } from "../../paths.ts";
import type { RemoteTargetFlags } from "../deployment.ts";
import { failStartup, optionalAgentDirOrExit } from "../fail.ts";
import type { InstanceFlags } from "../instance.ts";
import { logoutFlow } from "../login-ui.ts";
import { resolveRemoteAuthTarget, runRemoteLogout } from "../remote-login.ts";

export async function runLogout(
  provider: string | undefined,
  opts: RemoteTargetFlags & { global?: boolean; input?: boolean; instance?: InstanceFlags },
) {
  const remoteTarget = await resolveRemoteAuthTarget(opts);
  if (remoteTarget !== undefined) {
    await runRemoteLogout(remoteTarget.auth, remoteTarget.label, provider, {
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
    return;
  }
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(process.cwd());
  enterAgentEnv(agentDir ?? globalHome());
  const authPath = opts.global ? GLOBAL_AUTH_PATH : resolveAuthPath(agentDir ?? globalHome());
  const store = fastagentCredentialStore(authPath);
  const known = loginProviders(agentDir ? await definitionProviders(agentDir, process.env).catch(failStartup) : []);
  const stored = (await store.list())
    .map(({ providerId, type }) => ({
      id: providerId,
      type,
      name: known.find((p) => p.id === providerId)?.name ?? providerId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  await logoutFlow(
    {
      where: `in ${authPath}`,
      stored,
      selectMessage: "Select provider to logout:",
      delete: async (providerId) => {
        await store.delete(providerId);
        return true;
      },
      removedMessage: (chosen) =>
        chosen.type === "oauth"
          ? `[fastagent] logged out of ${chosen.name} — removed from ${authPath}`
          : `[fastagent] removed the stored API key for ${chosen.name} from ${authPath}; environment variables are unchanged`,
    },
    provider,
    opts,
  );
}
