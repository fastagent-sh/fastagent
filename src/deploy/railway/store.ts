/** Railway's service variables as a deployment's store: `railway variable list` for the names, `variables set` for values. */
import type { SecretStore } from "../secret-store.ts";
import { type CliRunner, readOutput } from "../runner.ts";

/** Whether `railway status --json` shows a linked project: non-empty stdout. */
export function isLinked(stdout: string): boolean {
  return stdout.trim() !== "";
}

/**
 * The linked project's name for the gate message, or undefined if it can't be read (still linked — `railway status
 * --json` puts `name` at the top level on 5.15.0).
 */
export function linkedName(stdout: string): string | undefined {
  try {
    const v = JSON.parse(stdout) as { name?: unknown };
    if (typeof v.name === "string") return v.name;
  } catch {
    // non-JSON but non-empty → still linked, just no name to show
  }
  return undefined;
}

/**
 * The project and service a deployment's values and image belong to, made when this directory is not linked to one:
 * `--run` provisions a NEW project and only runs on an unlinked directory unless `intoLinked` says to provision into
 * the linked one. Resolves the gate line when it cannot be done.
 */
export async function ensureRailwayService(
  railway: CliRunner,
  plan: { name: string; mountPath: string; intoLinked: boolean },
  log: (message: string) => void,
): Promise<string | undefined> {
  const status = await railway(["status", "--json"], { capture: true });
  if (isLinked(status.stdout)) {
    if (!plan.intoLinked) {
      const name = linkedName(status.stdout);
      return (
        `this directory is already linked to Railway project ${name ? `"${name}"` : "(name unreadable)"}. ` +
        "`--run` provisions a NEW project and only runs on an unlinked directory — it won't deploy into an " +
        "unrelated one. To redeploy an already-provisioned agent, run `railway up`. To provision the agent " +
        "INTO this project, re-run with --into-linked. To start fresh, `railway unlink` first."
      );
    }
    log(`provisioning into linked project ${linkedName(status.stdout) ?? plan.name} (--into-linked)`);
  } else {
    // --into-linked means "provision into the project this dir is linked to" — but it isn't linked.
    if (plan.intoLinked) {
      log("warn: --into-linked was passed but this directory isn't linked to any project — creating a fresh one");
    }
    log(`creating project ${plan.name}…`);
    if ((await railway(["init", "--name", plan.name])).code !== 0) {
      return "`railway init` failed — if you have multiple workspaces, run it once interactively (or pass --workspace) to pick one, then re-run";
    }
    // Create + link the service (init makes only a project); it precedes the volume, which has no --service flag and
    // rides the linked service.
    log(`creating service ${plan.name}…`);
    // `--variables` with one of the machinery variables set just below: in a terminal, a bare `railway add` stops at
    // "Enter a variable <esc to skip>" (5.62.1) and waits for a key nobody was told to press.
    const addArgs = ["add", "--service", plan.name, "--variables", `FASTAGENT_STATE_DIR=${plan.mountPath}/.state`];
    if ((await railway(addArgs)).code !== 0) {
      // Precise recovery, not "fix and re-run": init already created + linked the project, so a plain re-run hits the
      // linked-gate, and --into-linked SKIPS `add` and then fails at the volume (no service to ride).
      return (
        `\`railway add --service\` failed — \`railway init\` already created the project (this directory is now ` +
        `linked) but not the service. Finish with \`railway add --service ${plan.name}\` here, then re-run with ` +
        `--into-linked; or \`railway unlink\` to detach and start fresh.`
      );
    }
  }
  return undefined;
}

/** The names `railway variable list --json` shows: the keys of an object. Its values are never read. */
function variableNames(stdout: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not the parser's message: it quotes the text around the error, and this output holds every value.
    throw new Error("the output was not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object of variables, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
  }
  return new Set(Object.keys(parsed));
}

/**
 * `service`'s variables, in the project and environment this directory is linked to. `redeploy`: the service restarts on
 * what is written, once, after the last; off, for a deploy that follows and applies them.
 */
export function railwayStore(
  railway: CliRunner,
  service: string,
  log: (message: string) => void,
  options: { redeploy: boolean },
): SecretStore {
  const svc = ["--service", service];
  return {
    async exists() {
      return isLinked((await railway(["status", "--json"], { capture: true })).stdout);
    },
    async ensure() {
      // A directory linked to a project is the one it means; an unlinked one is made one, as a deploy would.
      if (isLinked((await railway(["status", "--json"], { capture: true })).stdout)) return;
      const gate = await ensureRailwayService(railway, { name: service, mountPath: "/data", intoLinked: false }, log);
      if (gate !== undefined) throw new Error(gate);
    },
    async names() {
      const listed = await readOutput(railway, "railway", ["variable", "list", "--json", ...svc], variableNames);
      if ("gate" in listed) throw new Error(listed.gate);
      return listed.value;
    },
    async write(values) {
      const names = Object.keys(values);
      log(`setting ${names.length} variable(s) on ${service}: ${names.join(", ")}`);
      // One value per call over stdin, never argv. `--skip-deploys` on all but the last of a write that is to take effect.
      for (const [index, name] of names.entries()) {
        const skip = options.redeploy && index === names.length - 1 ? [] : ["--skip-deploys"];
        const result = await railway(["variables", "set", name, "--stdin", ...skip, ...svc], {
          input: values[name] as string,
        });
        if (result.code !== 0)
          throw new Error(`\`railway variables set ${name}\` failed — see the railway output above`);
      }
    },
  };
}
