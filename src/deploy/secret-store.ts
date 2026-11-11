/**
 * Where a deployment's values live and how a deploy fills the gaps (agent-artifact.md §6.2). A target keeps its own
 * values; `deploy` checks names and never carries a file. Most stores can say which names they hold and not the values,
 * so that is all the interface asks of them.
 *
 * The gaps are filled from the person's own sources, in the order a deploy can ask least of them: the environment the
 * deploy runs in (a CI job's, or `op run`'s), or the file `--env-file` names, pushes the declared names it holds in one
 * batch after one question; a name no source has is asked for. A coding agent's run, with nobody to ask, stops naming
 * the commands instead. A deployment has no default value file.
 */
import type { SecretNeed } from "./secrets.ts";

export interface SecretStore {
  /** Whether the app or service the values belong to exists: absent, it holds no value, and `names()` cannot be asked. */
  exists(): Promise<boolean>;
  /** Make the app or service the values belong to, when it does not exist yet. */
  ensure(): Promise<void>;
  /** The names the target holds a value for. */
  names(): Promise<ReadonlySet<string>>;
  /** Set `values` in one batch. */
  write(values: Readonly<Record<string, string>>): Promise<void>;
}

/** How a person at a terminal is asked. */
export interface SecretAsker {
  confirm(question: string): Promise<boolean>;
  /** One value, typed without echo. */
  secret(need: SecretNeed): Promise<string>;
}

/** The commands a gate names, written for the host and agent this run is about. */
export interface SecretCommands {
  /** Push the names a source holds, without saying which source: `fastagent secrets push fly`. */
  push: string;
  /** Set one name: `fastagent secrets set fly NAME`. */
  set(name: string): string;
}

export interface ProvideSecrets {
  /** What the target is called in what is said: "Fly". */
  host: string;
  store: SecretStore;
  /** What the target must hold. */
  needs: readonly SecretNeed[];
  /** Every name the definition declares: a source's copy of one the target lacks is offered, optional or not. */
  known: readonly string[];
  /**
   * Where the values a deploy may offer come from: `file` names it in what is said ("the environment", or the
   * `--env-file`'s path) and `flags` are how `secrets push` is told to read it (`--from-env`, `--env-file F`). Several
   * when the sources are several: `push` takes one source per run, so each is a command of its own.
   */
  source?: { file: string; flags: readonly string[]; values: ReadonlyMap<string, string> };
  /** Absent: nobody to ask. */
  asker?: SecretAsker;
  commands: SecretCommands;
  /**
   * Values FastAgent makes itself, set when neither the target nor a source has one (the Agent API's key). Without
   * `make` a value is only restored from a source: made where nobody would see it, it would be a key no one holds, so
   * its absence is a gap the person fills (`hint` says how).
   */
  mint?: readonly { name: string; hint: string; make?: () => string }[];
  /** Say a line to the person who runs the deploy, for what a deploy with nobody to ask leaves undone. */
  say?: (line: string) => void;
  /** Say what the deploy did by itself, which leaves the person nothing to do. */
  inform?: (line: string) => void;
  /** What was minted, once the target holds it: kept on this machine too, where the person who calls the API looks. */
  onMinted?: (values: Readonly<Record<string, string>>) => Promise<void>;
}

/** The `secrets push` commands that read `source`: one per source it has, said as alternatives. */
function pushes(commands: SecretCommands, source: NonNullable<ProvideSecrets["source"]>): string {
  return source.flags.map((flag) => `\`${commands.push} ${flag}\``).join(" and ");
}

/** The gap the target has, as the line a person (or the agent relaying one) acts on. */
function gapLine(
  host: string,
  missing: readonly SecretNeed[],
  held: readonly string[],
  commands: SecretCommands,
  source: ProvideSecrets["source"],
): string {
  const names = missing.map((need) => `${need.name} (${need.hint})`).join("; ");
  const fromFile = missing.filter((need) => held.includes(need.name));
  const rest = missing.filter((need) => !held.includes(need.name));
  const ways = [
    ...(fromFile.length > 0 && source !== undefined
      ? [
          `${pushes(commands, source)} ${source.flags.length === 1 ? "sets" : "set, each from its own source,"} ${fromFile.length === 1 ? "the one" : "the ones"} ${source.file} holds (${fromFile.map((n) => n.name).join(", ")})`,
        ]
      : []),
    ...(rest.length > 0
      ? [
          `a person gives ${fromFile.length > 0 ? "the others" : rest.length === 1 ? "it" : "them"} in a terminal, one command each: ${rest.map((need) => `\`${commands.set(need.name)}\``).join(", ")}`,
        ]
      : []),
    ...(source?.flags.includes("--from-env")
      ? []
      : [
          `\`${commands.push} --from-env\` takes them from the environment of a secret manager or a CI job (\`op run\`, \`doppler run\`)`,
        ]),
  ];
  return `${host} has no value for: ${names}. ${ways.join("; ")}. Then re-run. A value is never asked for in a conversation`;
}

/** Resolves a gate line when the target still lacks a required name afterwards, undefined once it holds them all. */
export async function provideSecrets(input: ProvideSecrets): Promise<string | undefined> {
  const { host, store, needs, known, source, asker, commands, mint = [] } = input;
  try {
    const have = await store.names();
    const missing = needs.filter((need) => !have.has(need.name));
    const ours = new Set(mint.map((made) => made.name));
    const filed = (name: string) => {
      const value = source?.values.get(name);
      return value !== undefined && value.trim() !== "" ? value : undefined;
    };
    // What FastAgent made is not the person's to be asked about: a target that lacks it gets the value the source
    // holds (a deployment made again), and one the source lacks too gets a new one, shown once to the person at the
    // terminal who made it; with nobody to see it, its absence is a gap.
    const minted: Record<string, string> = {};
    const restored: string[] = [];
    const unmade: SecretNeed[] = [];
    for (const { name, hint, make } of mint) {
      if (have.has(name)) continue;
      const kept = filed(name);
      if (kept !== undefined) {
        minted[name] = kept;
        restored.push(name);
      } else if (make !== undefined) minted[name] = make();
      else unmade.push({ name, hint });
    }
    const offered = [...(source?.values ?? [])]
      .filter(([name, value]) => value.trim() !== "" && known.includes(name) && !have.has(name) && !ours.has(name))
      .map(([name]) => name);
    if (missing.length === 0 && unmade.length === 0 && offered.length === 0 && Object.keys(minted).length === 0) {
      return undefined;
    }
    const finishMinted = async () => {
      if (restored.length > 0) {
        input.inform?.(`set ${restored.join(", ")} on ${host} from ${source?.file}, where an earlier deploy kept it`);
      }
      const made = Object.fromEntries(Object.entries(minted).filter(([name]) => !restored.includes(name)));
      if (Object.keys(made).length > 0) await input.onMinted?.(made);
    };
    const held = offered.filter((name) => missing.some((need) => need.name === name));
    if (asker === undefined) {
      const lacking = [...missing.filter((need) => !(need.name in minted)), ...unmade];
      if (lacking.length > 0) return gapLine(host, lacking, held, commands, source);
      // Names a file holds and the target lacks, which nothing requires: said, since nobody was asked to set them.
      if (offered.length > 0 && source !== undefined) {
        input.say?.(
          `${host} lacks ${offered.join(", ")}, which ${source.file} holds; ${pushes(commands, source)} ${source.flags.length === 1 ? "sets" : "set, each from its own source,"} ${offered.length === 1 ? "it" : "them"}`,
        );
      }
      if (Object.keys(minted).length > 0) {
        await store.write(minted);
        await finishMinted();
      }
      return undefined;
    }
    const write: Record<string, string> = { ...minted };
    if (offered.length > 0 && source !== undefined) {
      const required = new Set(missing.map((need) => need.name));
      const list = offered.map((name) => (required.has(name) ? name : `${name} (optional)`)).join(", ");
      if (await asker.confirm(`${host} lacks ${list}, which ${source.file} holds. Set them on ${host} from it?`)) {
        for (const name of offered) write[name] = source.values.get(name) as string;
      }
    }
    for (const need of [...missing, ...unmade]) {
      if (need.name in write) continue;
      write[need.name] = await asker.secret(need);
    }
    if (Object.keys(write).length > 0) await store.write(write);
    if (Object.keys(minted).length > 0) await finishMinted();
    return undefined;
  } catch (error) {
    return `${host}'s values could not be read or set: ${error instanceof Error ? error.message : String(error)}`;
  }
}
