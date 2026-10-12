/**
 * THE JOIN: the agent's own declarations and those of the contexts it uses, as one, in ONE place, so every reader (the
 * opener, `info`, `env`, `content`, deploy) sees the same agent. Nothing is overridden: what two declare differently
 * refuses, naming both. docs/design/agent-service.md §3.6 is the rule.
 */
import type { DeclaredContent } from "../content/declare.ts";
import type { DeclaredEnvironment } from "../environment/declare.ts";

/** One declarer's part: the agent's own `context.json`, or a context's, and what `T` it declares. */
export interface DeclaredPart<T> {
  /** The context's name; undefined for the agent's own. */
  context?: string;
  /** The file it is read from, relative to the agent directory: what every refusal and report names. */
  source: string;
  declared: T;
}

/** The content every part declares, each entry marked with its context; a name declared twice refuses. */
export function joinContent(parts: readonly DeclaredPart<DeclaredContent[]>[]): DeclaredContent[] {
  const byName = new Map<string, string>();
  return parts.flatMap(({ context, source, declared }) =>
    declared.map((entry) => {
      // Equal ignoring case is the same name: it becomes a directory, `content/<name>`.
      const key = entry.name.toLowerCase();
      const first = byName.get(key);
      if (first !== undefined) {
        throw new Error(
          `content "${entry.name}" is declared by ${first} and by ${source} — rename or remove one of them`,
        );
      }
      byName.set(key, source);
      return context === undefined ? entry : { ...entry, context };
    }),
  );
}

/**
 * The environment every part declares, joined: the packages and apt packages of all, and their variables, one per
 * name; undefined when none declares one. A package at two versions refuses, naming both; one declared twice at one
 * version is one package.
 */
export function joinEnvironment(
  parts: readonly DeclaredPart<DeclaredEnvironment | undefined>[],
): DeclaredEnvironment | undefined {
  const declaring = parts.filter((part) => part.declared !== undefined);
  if (declaring.length === 0) return undefined;
  const packages: Record<string, string> = {};
  const packageSource = new Map<string, string>();
  const aptPackages: string[] = [];
  const variables: DeclaredEnvironment["variables"] = {};
  for (const { source, declared } of declaring) {
    const environment = declared as DeclaredEnvironment;
    for (const [name, version] of Object.entries(environment.packages)) {
      const first = packageSource.get(name);
      if (first !== undefined && packages[name] !== version) {
        throw new Error(
          `package "${name}" is declared at "${packages[name]}" by ${first} and at "${version}" by ${source} — ` +
            `declare one version`,
        );
      }
      packages[name] = version;
      if (first === undefined) packageSource.set(name, source);
    }
    for (const name of environment.aptPackages) if (!aptPackages.includes(name)) aptPackages.push(name);
    for (const [name, variable] of Object.entries(environment.variables)) {
      if (!Object.hasOwn(variables, name)) variables[name] = variable;
    }
  }
  return { packages, aptPackages, variables };
}
