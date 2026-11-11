/** Fly's secrets as a deployment's store: `fly secrets list` for the names, `fly secrets set NAME=-` to set each. */
import type { SecretStore } from "../secret-store.ts";
import { type CliRunner, readOutput } from "../runner.ts";

/**
 * Whether `fly apps list --json` lists an app called `name`. flyctl capitalizes the field, and an
 * offline fixture can only repeat what we already believe, so a change in flyctl's output is not caught here.
 */
function listHasName(stdout: string, name: string): boolean {
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error(`expected a JSON array, got ${typeof entries}`);
  return entries.some((o) => (o as { Name?: string }).Name === name);
}

/** The names `fly secrets list --json` shows (it never prints a value): each entry's `Name`. */
function secretNames(stdout: string): Set<string> {
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error(`expected a JSON array, got ${typeof entries}`);
  return new Set(
    entries.flatMap((entry) => {
      const { Name, name } = entry as { Name?: unknown; name?: unknown };
      const found = Name ?? name;
      return typeof found === "string" ? [found] : [];
    }),
  );
}

/** Create the app when `fly apps list` does not show it. Resolves the gate line when it cannot be made. */
export async function ensureFlyApp(
  fly: CliRunner,
  app: string,
  log: (message: string) => void,
): Promise<string | undefined> {
  const exists = await readOutput(fly, "fly", ["apps", "list", "--json"], (out) => listHasName(out, app));
  if ("gate" in exists) return exists.gate;
  if (exists.value) {
    log(`app ${app} exists — skipping create`);
    return undefined;
  }
  log(`creating app ${app}…`);
  if ((await fly(["apps", "create", app])).code !== 0) {
    return (
      `\`fly apps create ${app}\` failed — see the flyctl output above: the name may be taken (Fly app names are ` +
      `globally unique: set a unique \`app\` in the instance's fly.<name>.toml) or the account may need payment information. Then re-run.`
    );
  }
  return undefined;
}

/** What `fly secrets set NAME=-` reads from standard input. */
const FLY_STDIN_LIMIT = 64 * 1024;

/**
 * `stage`: set the secrets without deploying them, for a deploy that follows (`fly deploy` applies staged ones); off, a
 * running app restarts on them at once.
 */
export function flyStore(
  fly: CliRunner,
  app: string,
  log: (message: string) => void,
  options: { stage: boolean },
): SecretStore {
  return {
    async exists() {
      const listed = await readOutput(fly, "fly", ["apps", "list", "--json"], (out) => listHasName(out, app));
      if ("gate" in listed) throw new Error(listed.gate);
      return listed.value;
    },
    async ensure() {
      const gate = await ensureFlyApp(fly, app, log);
      if (gate !== undefined) throw new Error(gate);
    },
    async names() {
      const listed = await readOutput(fly, "fly", ["secrets", "list", "-a", app, "--json"], secretNames);
      if ("gate" in listed) throw new Error(listed.gate);
      return listed.value;
    },
    async write(values) {
      const names = Object.keys(values);
      const tooLong = names.find((name) => Buffer.byteLength(values[name] as string) > FLY_STDIN_LIMIT);
      if (tooLong !== undefined) {
        throw new Error(
          `${tooLong} is longer than the ${FLY_STDIN_LIMIT} bytes \`fly secrets set\` reads from standard input`,
        );
      }
      log(`setting ${names.length} secret(s) on ${app}: ${names.join(", ")}`);
      // `NAME=-` reads the value from standard input exactly as it is, and never from argv. `import` reads a dotenv-like
      // line instead and changes a value that holds `#` or quotes, so it is not used. Staged, a running app restarts once,
      // on the last.
      for (const [index, name] of names.entries()) {
        const last = index === names.length - 1;
        const args = ["secrets", "set", ...(options.stage || !last ? ["--stage"] : []), "-a", app, `${name}=-`];
        if ((await fly(args, { input: values[name] as string })).code !== 0) {
          throw new Error(`\`fly secrets set ${name}=-\` failed — see the flyctl output above`);
        }
      }
    },
  };
}
