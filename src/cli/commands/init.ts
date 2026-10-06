/** `fastagent init <dir> [--context <dir>]...`: scaffold a runnable agent and install its dependencies. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { displayPath } from "../../paths.ts";
import { scaffoldAgent } from "../../scaffold/init.ts";
import { writeContexts } from "../../engines/pi/config.ts";
import { declarationFor } from "../../contexts/source.ts";
import { resolveContexts } from "../../contexts/resolve.ts";
import { contextLines } from "../contexts-view.ts";
import { failStartup, failUsage } from "../fail.ts";

export interface InitOptions {
  /** false ⇔ `--no-install`. */
  install: boolean;
  /** `--context` sources, each a directory the agent works on. */
  contexts: string[];
  /** `--copy`: a host gets its own copy of each of them. */
  copy: boolean;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  if (opts.copy && opts.contexts.length === 0) failUsage("--copy applies to the --context directories; none was given");
  // Every context is checked BEFORE anything is created — a nested or missing one refuses with the scaffold unwritten.
  const read = await Promise.resolve()
    .then(() => opts.contexts.map((source) => declarationFor(source, process.cwd(), { copy: opts.copy })))
    .catch(failStartup);
  const declarations = read.map((source) => source.declaration);
  const contexts = await Promise.resolve()
    .then(() => resolveContexts(dir, declarations))
    .catch(failStartup);
  const { created, undo } = await scaffoldAgent(dir).catch(failStartup);
  // The same write `fastagent context add` makes: the literal list, imported and compared before it is kept. The
  // contexts were checked above, so a refusal here is one that check could not foresee (the disk changed in between);
  // the scaffold goes with it, or a retry would find "already an agent" holding no contexts.
  if (declarations.length > 0) {
    await writeContexts(dir, declarations).catch(async (error: unknown) => {
      await undo();
      failStartup(error);
    });
  }
  console.error(`[fastagent] created ${dir}`);
  for (const note of read.flatMap((source) => source.notes)) console.error(`  ${note}`);
  if (contexts.length > 0) for (const [label, value] of contextLines(contexts)) console.error(`  ${label} ${value}`);
  console.error(`  files: ${created.join(", ")}`);
  let installFailed = false;
  if (opts.install) {
    console.error(`[fastagent] installing dependencies (npm install)…`);
    installFailed = (await npmInstall(dir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${dir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = displayPath(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (!opts.install || installFailed) console.error(`    npm install`);
  console.error(`    fastagent dev   # serve locally and iterate`);
  console.error(`    fastagent add skill <owner/repo/path>   # vendor more skills from GitHub`);
}

/** Run `npm install` in `cwd` (inherit stdio). */
function npmInstall(cwd: string): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn("npm", ["install"], { cwd, stdio: "inherit" });
    child.on("close", (code) => resolveCode(code ?? 1));
    child.on("error", () => resolveCode(1));
  });
}
