/**
 * A channel the development instance has no credentials for yet is set up the first time `dev` runs,
 * the way the first run picks a model: in the parent process, at a terminal, once per project. Without a terminal
 * nothing is asked and nothing waits: the command that does it for a coding agent is named.
 */
import { channelSource, codeSecrets } from "../harnesses/pi-durable/definition.ts";
import { loadSourceDefinition } from "../harnesses/pi-durable/open.ts";
import { missingSecrets } from "../declared-secrets.ts";
import { dotEnvPath, loadEnvValues } from "../value-file.ts";
import { SETUP_KINDS, type SetupKind, setUpChannel, setupNames } from "./channel-setup.ts";
import { failStartup, failUsage } from "./fail.ts";
import { isInteractive } from "./shared.ts";

/**
 * The setups that supply what the agent's channels lack in this process's environment, each with the channel that
 * lacks it. Only what a setup supplies: a channel reading other variables is its author's to fill.
 */
async function lackingChannels(agentDir: string): Promise<{ kind: SetupKind; channel: string }[]> {
  const definition = await loadSourceDefinition(agentDir).catch(failStartup);
  const missing = missingSecrets(codeSecrets(definition), process.env);
  return Object.keys(definition.config.channels ?? {}).flatMap((channel) => {
    const lacking = missing.filter((secret) => secret.declaredIn === channelSource(channel)).map(({ name }) => name);
    const kind = SETUP_KINDS.find((each) => setupNames(each).some((name) => lacking.includes(name)));
    return kind === undefined ? [] : [{ kind, channel }];
  });
}

export async function setUpMissingChannels(agentDir: string, opts: { input?: boolean } = {}): Promise<void> {
  const lacking = await lackingChannels(agentDir);
  if (lacking.length === 0) return;
  if (opts.input === false || !isInteractive()) {
    const says = lacking
      .map(
        ({ kind, channel }) =>
          `channel "${channel}" has no credentials in ${dotEnvPath(agentDir)}: run ` +
          `\`fastagent channels setup ${kind} --json\``,
      )
      .join("; ");
    failUsage(`${says} (it hands the person's part to its user), or run \`fastagent dev\` in a terminal, which asks`);
  }

  const file = dotEnvPath(agentDir);
  for (const { kind, channel } of lacking) {
    console.error(
      `[fastagent] channel "${channel}" has no credentials in ${file} yet: setting it up ` +
        `(\`fastagent channels setup ${kind}\`)`,
    );
    const outcome = await setUpChannel({
      kind,
      agentDir,
      file,
      dev: true,
      rerun: `fastagent channels setup ${kind}`,
      interactive: true,
    }).catch((error: unknown) =>
      failStartup(
        new Error(
          `${kind} setup did not finish (${(error as Error).message}): \`dev\` needs it while ${channelSource(channel)} ` +
            `is declared. Run \`fastagent channels setup ${kind}\` when ready, or remove the channel`,
          { cause: error },
        ),
      ),
    );
    if (outcome.status === "done") {
      // What setup wrote is this process's now, and the dev worker's: a value it replaced would otherwise keep the old one.
      const values = loadEnvValues(file);
      for (const name of outcome.written) process.env[name] = values.get(name) as string;
      if (outcome.after.length > 0) {
        console.error("  next steps:");
        for (const line of outcome.after) console.error(`    ${line}`);
      }
    }
  }
}
