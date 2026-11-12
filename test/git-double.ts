/**
 * `src/git.ts` for a unit test whose subject is not git: a machine without git, unless the test says what git answers
 * in a directory. Installed with `vi.mock("../src/git.ts", () => import("./git-double.ts"))`;
 * git-double.integration.test.ts checks both against the real module.
 */
export class GitNotInstalled extends Error {}

const scripted = new Map<string, Record<string, string | undefined>>();

/** What git answers in `dir`: each command line to its output, `undefined` for a non-zero exit (git's "no"). */
export function gitAnswersIn(dir: string, answers: Record<string, string | undefined>): void {
  scripted.set(dir, answers);
}

export function gitFor(why: string, _env?: NodeJS.ProcessEnv) {
  const missing = () => new GitNotInstalled(`git is not installed: ${why}`);
  return {
    answer(args: string[], cwd: string): string | undefined {
      const answers = scripted.get(cwd);
      if (answers === undefined) throw missing();
      const line = args.join(" ");
      if (!(line in answers)) throw new Error(`git-double: no answer for \`git ${line}\` in ${cwd}`);
      return answers[line];
    },
    async run(_args: string[], _cwd: string): Promise<string> {
      throw missing();
    },
  };
}
