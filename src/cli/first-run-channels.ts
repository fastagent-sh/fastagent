/**
 * A channel the development instance has no credentials for yet is set up the first time `dev` runs,
 * the way the first run picks a model: in the parent process, at a terminal, once per project. Without a terminal
 * nothing is asked and nothing waits: the command that does it for a coding agent is named.
 */
import { codeSecrets } from "../harnesses/pi-durable/definition.ts";
import { loadSourceDefinition } from "../harnesses/pi-durable/open.ts";
import { missingSecrets } from "../declared-secrets.ts";
import { dotEnvPath, loadEnvValues } from "../value-file.ts";
import { type SetupKind, isSetupKind, setUpChannel, setupNames } from "./channel-setup.ts";
import { failStartup, failUsage } from "./fail.ts";
import { isInteractive } from "./shared.ts";

/** The first-party channels the agent mounts whose credentials this process's environment lacks. */
async function lackingChannels(agentDir: string): Promise<SetupKind[]> {
  const definition = await loadSourceDefinition(agentDir).catch(failStartup);
  const missing = missingSecrets(codeSecrets(definition), process.env);
  return definition.registry.channels.flatMap(({ file, name }) => {
    if (!isSetupKind(name)) return [];
    // Only what the channel's own setup supplies: a channel file of the same name that reads other variables is its
    // author's to fill.
    const supplied = setupNames(name);
    return missing.some((secret) => secret.declaredIn === file && supplied.includes(secret.name)) ? [name] : [];
  });
}

export async function setUpMissingChannels(agentDir: string, opts: { input?: boolean } = {}): Promise<void> {
  const kinds = await lackingChannels(agentDir);
  if (kinds.length === 0) return;
  if (opts.input === false || !isInteractive()) {
    const lacking = kinds
      .map(
        (kind) =>
          `${kind} has no credentials in ${dotEnvPath(agentDir)}: run \`fastagent channels setup ${kind} --json\``,
      )
      .join("; ");
    failUsage(
      `${lacking} (it hands the person's part to its user), or run \`fastagent dev\` in a terminal, which asks`,
    );
  }

  const file = dotEnvPath(agentDir);
  for (const kind of kinds) {
    console.error(
      `[fastagent] ${kind} has no credentials in ${file} yet: setting it up (\`fastagent channels setup ${kind}\`)`,
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
          `${kind} setup did not finish (${(error as Error).message}): \`dev\` needs it while src/channels/${kind}.ts ` +
            `exists. Run \`fastagent channels setup ${kind}\` when ready, or remove the file`,
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
