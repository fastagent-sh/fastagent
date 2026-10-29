/**
 * `fastagent logout [provider]`: remove the credential `login` stored for a provider, as pi's `/logout` does, from the
 * file `login` writes (the agent's, or with `-g` or outside an agent the global one). Environment variables and the
 * grant at the provider are left as they are.
 */
import { enterAgentEnv } from "../../env.ts";
import { GLOBAL_AUTH_PATH, fastagentCredentialStore, resolveAuthPath } from "../../harnesses/models/credentials.ts";
import { loginProviders } from "../../harnesses/models/models.ts";
import { definitionProviders } from "../../harnesses/pi-durable/open.ts";
import { globalHome } from "../../paths.ts";
import { failStartup, failUsage, optionalAgentDirOrExit } from "../fail.ts";
import { isInteractive, terminalLoginIO } from "../shared.ts";

export async function runLogout(provider: string | undefined, opts: { global?: boolean; input?: boolean }) {
  const agentDir = opts.global ? undefined : optionalAgentDirOrExit(process.cwd());
  enterAgentEnv(agentDir ?? globalHome());
  const authPath = opts.global ? GLOBAL_AUTH_PATH : resolveAuthPath(agentDir ?? globalHome());
  const store = fastagentCredentialStore(authPath);
  const known = loginProviders(agentDir ? await definitionProviders(agentDir).catch(failStartup) : []);
  const stored = (await store.list())
    .map(({ providerId, type }) => ({
      id: providerId,
      type,
      name: known.find((p) => p.id === providerId)?.name ?? providerId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const held = stored.length === 0 ? "it holds none" : `it holds ${stored.map(({ id }) => id).join(", ")}`;

  let chosen: (typeof stored)[number] | undefined;
  if (provider !== undefined) {
    const named = provider.trim().toLowerCase();
    chosen = stored.find(({ id, name }) => id.toLowerCase() === named || name.toLowerCase() === named);
    if (chosen === undefined)
      failStartup(new Error(`no credential for "${provider}" is stored in ${authPath}: ${held}`));
  } else if (stored.length === 0) {
    console.error(
      `[fastagent] no credential is stored in ${authPath}; environment variables are not login's to remove`,
    );
    return;
  } else if (opts.input === false || !isInteractive()) {
    failUsage(`name the provider to log out of: ${held} (${authPath})`);
  } else {
    const value = await terminalLoginIO().select(
      "Select provider to logout:",
      stored.map(({ id, name, type }) => ({ value: id, label: name, hint: type === "oauth" ? "account" : "API key" })),
    );
    chosen = stored.find(({ id }) => id === value);
    if (chosen === undefined) {
      console.error("[fastagent] logout cancelled");
      process.exit(1);
    }
  }
  await store.delete(chosen.id);
  console.error(
    chosen.type === "oauth"
      ? `[fastagent] logged out of ${chosen.name} — removed from ${authPath}`
      : `[fastagent] removed the stored API key for ${chosen.name} from ${authPath}; environment variables are unchanged`,
  );
}
