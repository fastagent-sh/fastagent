/**
 * WHICH ENV VARS THIS AGENT NEEDS — the one shape the answer travels in, wherever it was declared.
 *
 * Before this existed the concept had three homes and one hole: a first-party channel declared its
 * vars in the scaffold table (typed, with hints), `fastagent.config` `deploy.secrets` listed names as
 * bare strings, the model key was inferred by a third mechanism — and a TOOL, the thing authors write
 * most, declared nothing at all. A tool's need lived only inside `process.env.X` in its own body, so
 * `deploy` could not carry it and nothing could check it: the name had to be copied by hand into
 * `deploy.secrets`, and forgetting meant the deployed box read `undefined` on the first real call,
 * days later, with the error only in the host's logs.
 *
 * So the declaration moved next to the code that needs it (`defineTool({ secrets: [...] })`,
 * `defineSchedule({ secrets: [...] })`), and this module is where every source converges. Two things
 * follow from having ONE list, and they are the whole point:
 *
 *  - `deploy` CARRIES a declared name automatically — no second list to keep in sync.
 *  - a serving path ASSERTS the values before it runs, so a missing one is a startup failure naming
 *    the file, not a 401 three days later (the same contract a channel already has: an empty
 *    `botToken` fails `telegramChannel` at mount).
 *
 * Agent code does not read `process.env`: each authoring surface (`defineTool`, `defineChannel`,
 * `defineSchedule`) hands back exactly the values it declared, so the declaration cannot drift from
 * the read, and a typo is a type error rather than an `undefined` at 3am. What this can NOT force is
 * the environment itself — a provider SDK reads its own variable, and the coding tools need `PATH`
 * and `HOME` — so the values still travel through the process env; what changes is that no authored
 * file has a reason to reach into it.
 */

/** One env var some part of the definition declared, and where that declaration is. */
export interface DeclaredSecret {
  /** The env-var name. */
  name: string;
  /** Where it was declared: "tools/x-post.ts", "schedules/daily-digest.ts", "config.tools",
   *  "fastagent.config deploy.secrets" — printed in runbooks and failures, so it must name a place
   *  the author can open. */
  source: string;
}

/**
 * What an env-var NAME may look like. Checked at the declaration, not left to the host: these names
 * are written verbatim into a Compose file, a Fly/Railway runbook and a CloudFormation parameter, so
 * a typo (`"X_API_KEY "`, `"my key"`) or a quote/newline produces a broken or wrong artifact whose
 * error surfaces in someone's cloud CLI, pointing at nothing. Case is not dictated — `http_proxy` is
 * a real variable — only the shape a shell and every artifact format agree on.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why an authored `secrets:` is unusable, or undefined when it is fine. A `.js` tool or a wrong type
 *  never met TypeScript, and a malformed declaration must fail as a load error rather than be
 *  silently dropped — the whole value of the field is that its absence is meaningful. */
function secretNamesProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "secrets must be an array of env-var names";
  for (const name of value) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      return `secrets must be an array of env-var names — ${JSON.stringify(name)} is not one`;
    }
  }
  return undefined;
}

/**
 * THE READ: what a code-input module declared, attributed to its file — the one implementation for
 * `tools/`, `schedules/` and `channels/`.
 *
 * It is one function because it was four, and the fourth was written without the shape check the
 * other three had: a `secrets: "FOO"` in a channel file crashed the whole directory with a
 * `TypeError` naming nothing, while the same mistake in a tool was that file's load failure. What a
 * caller DOES with a bad declaration still differs (push a failure and skip, or throw inside its own
 * per-file try), so the verdict travels back as data rather than as an exception.
 */
export function readSecretDeclaration(
  moduleDefault: unknown,
  label: string,
): { secrets: DeclaredSecret[]; error?: undefined } | { secrets?: undefined; error: string } {
  const declared = (moduleDefault as { secrets?: unknown } | undefined)?.secrets;
  const problem = secretNamesProblem(declared);
  if (problem !== undefined) return { error: `${label}: ${problem}` };
  return { secrets: ((declared as readonly string[] | undefined) ?? []).map((name) => ({ name, source: label })) };
}

/** Every owner's declarations as one list — what a path that runs ALL of them (a serve, a deploy)
 *  asserts or carries. A path that runs ONE reads that owner's entry instead. */
export function allSecrets(byOwner: ReadonlyMap<string, readonly DeclaredSecret[]>): DeclaredSecret[] {
  return [...byOwner.values()].flat();
}

/** Declared names as a stable list, first declaration winning — the form a carrier iterates. */
export function dedupeSecrets(declared: readonly DeclaredSecret[]): DeclaredSecret[] {
  const seen = new Set<string>();
  return declared.filter((s) => !seen.has(s.name) && seen.add(s.name));
}

/**
 * The values for a declared list, as the authoring surfaces hand them to author code. A name with no
 * value reads as `""` rather than throwing: the deploy pre-flight IMPORTS these modules on a machine
 * that legitimately holds no secrets, and a throwing accessor would make the channel whose secrets we
 * came to collect unloadable. Presence is guaranteed by the gate (src/secrets-gate.ts) on the paths
 * that run the code, which is the one place that can tell "not set" from "not needed here".
 */
export function secretValues<const S extends readonly string[]>(
  names: S | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<S[number], string> {
  const values = {} as Record<S[number], string>;
  for (const name of names ?? []) values[name as S[number]] = env[name] ?? "";
  return values;
}

/** Declared names with no value in `env` — empty string counts as missing (an unset `.env` line). */
export function missingSecrets(
  declared: readonly DeclaredSecret[],
  env: NodeJS.ProcessEnv = process.env,
): DeclaredSecret[] {
  return dedupeSecrets(declared).filter((s) => !env[s.name]);
}

/** "X_API_KEY, X_API_SECRET (tools/x-post.ts); SLACK_TOKEN (schedules/digest.ts)" — grouped by the
 *  file to open, since that is the unit the author fixes. */
export function describeSecrets(declared: readonly DeclaredSecret[]): string {
  const bySource = new Map<string, string[]>();
  for (const { name, source } of dedupeSecrets(declared)) {
    bySource.set(source, [...(bySource.get(source) ?? []), name]);
  }
  return [...bySource].map(([source, names]) => `${names.join(", ")} (${source})`).join("; ");
}
