/**
 * WHICH ENV VARS THIS AGENT NEEDS, in ONE shape, wherever it was declared: `needs(...)`, next to the code that reads
 * the value, and the `variables` of `context.json`, for the commands the agent runs.
 *
 * One list, two consequences:
 *  - opening the agent ASSERTS the values first, so a missing one is a startup failure naming the file, not a 401
 *    three days later;
 *  - `deploy --run` refuses a value file that does not supply one.
 *
 * Agent code does not read `process.env`: `needs` hands back exactly the values it declared, so the declaration cannot
 * drift from the read, and a typo is a type error. A command the agent runs (`gh`) reads its own variable from the
 * process env, so a `context.json` declaration hands nothing back. The values travel through the process env, and
 * `deploy` carries the whole value file (deploy/secrets.ts) — a declaration makes a value REQUIRED, it does not decide
 * what travels.
 */
/**
 * What an env-var NAME may look like. Checked at the declaration, not left to the host: these names
 * are written verbatim into a Compose file, a Fly/Railway runbook and a CloudFormation parameter, so
 * a typo (`"X_API_KEY "`, `"my key"`) or a quote/newline produces a broken or wrong artifact whose
 * error surfaces in someone's cloud CLI, pointing at nothing. Case is not dictated — `http_proxy` is
 * a real variable — only the shape a shell and every artifact format agree on.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Whether `name` has the shape of an env-var name ({@link ENV_NAME}). */
export function isEnvName(name) {
    return ENV_NAME.test(name);
}
/** Declared names as a stable list, first declaration winning — the form a carrier iterates. */
export function dedupeSecrets(declared) {
    const seen = new Set();
    return declared.filter((s) => !seen.has(s.name) && seen.add(s.name));
}
/** Required names with no value in `env` — empty string counts as missing (an unset `.env` line). A name some
 *  declaration requires is required, whatever another says. */
export function missingSecrets(declared, env = process.env) {
    return dedupeSecrets(declared.filter((s) => !s.optional)).filter((s) => !env[s.name]);
}
/** "X_API_KEY, X_API_SECRET (src/tools/x-post.ts); SLACK_TOKEN (src/channels/slack.ts)" — grouped by the
 *  file to open, since that is the unit the author fixes. */
export function describeSecrets(declared) {
    const bySource = new Map();
    for (const { name, declaredIn } of dedupeSecrets(declared)) {
        bySource.set(declaredIn, [...(bySource.get(declaredIn) ?? []), name]);
    }
    return [...bySource].map(([source, names]) => `${names.join(", ")} (${source})`).join("; ");
}
