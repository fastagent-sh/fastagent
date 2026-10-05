/** `fastagent init <dir>`: scaffold a runnable agent and install its dependencies. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { displayPath } from "../../paths.ts";
import { scaffoldAgent } from "../../scaffold/init.ts";
import { failStartup } from "../fail.ts";

export interface InitOptions {
  /** false ⇔ `--no-install`. */
  install: boolean;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  const { created } = await scaffoldAgent(dir).catch(failStartup);
  console.error(`[fastagent] created ${dir}`);
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
