/**
 * Where a deployment's values live and how a deploy fills the gaps (agent-artifact.md §6.2). A target keeps its own
 * values; `deploy` checks names and never carries a file. Most stores can say which names they hold and not the values,
 * so that is all the interface asks of them.
 *
 * The gaps are filled from the person's own sources, in the order a deploy can ask least of them: a value file
 * (`.secrets/production/.env` unless another is named) pushes the names it holds in one batch after one question; a name
 * no source has is asked for. A coding agent's run, with nobody to ask, stops naming the commands instead.
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
  /** Push the names a value file holds: `fastagent secrets push fly`. */
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
  /** The value file a source reads, when it exists. */
  source?: { file: string; values: ReadonlyMap<string, string> };
  /** Absent: nobody to ask. */
  asker?: SecretAsker;
  commands: SecretCommands;
  /** Values FastAgent makes itself, set when neither the target nor a source has one (the Agent API's key). */
  mint?: readonly { name: string; make(): string }[];
  /** Say a line to the person who runs the deploy, for what a deploy with nobody to ask leaves undone. */
  say?: (line: string) => void;
  /** What was minted, once the target holds it: kept on this machine too, where the person who calls the API looks. */
  onMinted?: (values: Readonly<Record<string, string>>) => Promise<void>;
}

/** The gap the target has, as the line a person (or the agent relaying one) acts on. */
function gapLine(
  host: string,
  missing: readonly SecretNeed[],
  held: readonly string[],
  commands: SecretCommands,
): string {
  const names = missing.map((need) => `${need.name} (${need.hint})`).join("; ");
  const fromFile = missing.filter((need) => held.includes(need.name));
  const rest = missing.filter((need) => !held.includes(need.name));
  const ways = [
    ...(fromFile.length > 0
      ? [
          `\`${commands.push}\` sets ${fromFile.length === 1 ? "the one" : "the ones"} a value file holds (${fromFile.map((n) => n.name).join(", ")})`,
        ]
      : []),
    ...(rest.length > 0
      ? [
          `a person types ${fromFile.length > 0 ? "the others" : rest.length === 1 ? "it" : "them"} in a terminal, one command each: ${rest.map((need) => `\`${commands.set(need.name)}\``).join(", ")}`,
        ]
      : []),
    `\`${commands.push} --from-env\` takes them from the environment of a secret manager or a CI job (\`op run\`, \`doppler run\`)`,
  ];
  return `${host} has no value for: ${names}. ${ways.join("; ")}. Then re-run. A value is never asked for in a conversation`;
}

/** Resolves a gate line when the target still lacks a required name afterwards, undefined once it holds them all. */
export async function provideSecrets(input: ProvideSecrets): Promise<string | undefined> {
  const { host, store, needs, known, source, asker, commands, mint = [] } = input;
  try {
    const have = await store.names();
    const missing = needs.filter((need) => !have.has(need.name));
    const offered = [...(source?.values ?? [])]
      .filter(([name, value]) => value.trim() !== "" && known.includes(name) && !have.has(name))
      .map(([name]) => name);
    const minted: Record<string, string> = {};
    // Made only where nobody holds one: not on the target, and not in the file that would be offered.
    for (const { name, make } of mint) if (!have.has(name) && !offered.includes(name)) minted[name] = make();
    if (missing.length === 0 && offered.length === 0 && Object.keys(minted).length === 0) return undefined;
    const held = offered.filter((name) => missing.some((need) => need.name === name));
    if (asker === undefined) {
      const lacking = missing.filter((need) => !(need.name in minted));
      if (lacking.length > 0) return gapLine(host, lacking, held, commands);
      // Names a file holds and the target lacks, which nothing requires: said, since nobody was asked to set them.
      if (offered.length > 0 && source !== undefined) {
        input.say?.(
          `${host} lacks ${offered.join(", ")}, which ${source.file} holds; \`${commands.push}\` sets ${offered.length === 1 ? "it" : "them"}`,
        );
      }
      if (Object.keys(minted).length > 0) {
        await store.write(minted);
        await input.onMinted?.(minted);
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
    for (const need of missing) {
      if (need.name in write) continue;
      write[need.name] = await asker.secret(need);
    }
    if (Object.keys(write).length > 0) await store.write(write);
    if (Object.keys(minted).length > 0) await input.onMinted?.(minted);
    return undefined;
  } catch (error) {
    return `${host}'s values could not be read or set: ${error instanceof Error ? error.message : String(error)}`;
  }
}
