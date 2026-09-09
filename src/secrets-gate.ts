/**
 * THE GATE: refuse to run while a declaration for what is ABOUT TO RUN has no value.
 *
 * `declared-secrets.ts` answers "which env vars did this code declare, and which have no value" —
 * a predicate. This module owns the three decisions that turn that predicate into a refusal, and it
 * exists because those three were hand-written at five call sites (the agent opener, the scheduler
 * start, channel loading, `fastagent tool`, `fastagent fire`) and review found one or another of
 * them wrong seven times:
 *
 *  1. WHICH declarations gate this run. A serve mounts every tool, schedule and channel, so all of
 *     them gate it; `fastagent tool <name>` / `fire <name>` run exactly one owner, and requiring the
 *     credentials of the ones they are not running blocks a machine that is configured correctly for
 *     the job at hand. That is why declarations travel keyed BY OWNER.
 *  2. ORDER against load failures. The refusal throws, and a caller that prints `failures` after it
 *     gets a value back would lose them: a broken `tools/x.ts` beside an unset declaration would
 *     stay invisible until the author fixed the environment and ran again. So the gate reports them
 *     itself, on the refusal path, before throwing. A caller that also reports on its own success
 *     path is correct; one that reports before gating merely repeats a line, which is cosmetic —
 *     the signal cannot be lost either way.
 *  3. The failure SHAPE. This throws a plain `Error` (a user-fixable startup problem). CLI commands
 *     whose call is synchronous route it through the process boundary with `gateSecretsOrExit`
 *     (cli/fail.ts) so the author sees the one line naming the file, never a Node stack.
 */
import { type DeclaredSecret, allSecrets, describeSecrets, missingSecrets } from "./declared-secrets.ts";
import { type ModuleLoadFailure, reportModuleLoadFailures } from "./loader.ts";

export function gateSecrets(input: {
  /** Owner (tool / schedule / channel name) → what it declared, as the loaders return it. */
  declared: ReadonlyMap<string, readonly DeclaredSecret[]>;
  /** What could not be loaded from the same directory — reported before any refusal (decision 2). */
  failures: readonly ModuleLoadFailure[];
  /** The ONE owner about to run; omitted means every one of them is about to run. */
  owner?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const scope = input.owner === undefined ? allSecrets(input.declared) : (input.declared.get(input.owner) ?? []);
  const missing = missingSecrets(scope, input.env);
  if (missing.length === 0) return;
  reportModuleLoadFailures(input.failures);
  throw new Error(
    `missing required secrets: ${describeSecrets(missing)} — set them in .secrets/.env (or the ` +
      `environment). Deployed, they travel as deploy secrets; a tool that should run WITHOUT the ` +
      `value must not declare it.`,
  );
}
