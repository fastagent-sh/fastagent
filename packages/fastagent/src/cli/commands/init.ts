/** `fastagent init <dir>`: scaffold a runnable agent, install its dependencies, and start its git repository. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { displayPath } from "../../paths.ts";
import { initRepository, scaffoldAgent } from "../../scaffold/init.ts";
import { failStartup } from "../fail.ts";

export interface InitOptions {
  /** false ⇔ `--no-install`. */
  install: boolean;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  const { created } = await scaffoldAgent(dir).catch(failStartup);
  let installFailed = false;
  if (opts.install) {
    console.error(`[fastagent] installing dependencies (npm install)…`);
    installFailed = (await npmInstall(dir)) !== 0;
    if (installFailed) {
      console.error(`[fastagent] warn: npm install failed — run it manually in ${dir} before \`npm run dev\``);
    }
  }
  const repository = await initRepository(dir);
  console.error(`[fastagent] created ${dir}`);
  console.error(`  files: ${created.join(", ")}`);
  console.error(`[fastagent] git: ${repository}`);

  console.error(`  next steps:`);
  const cdTarget = displayPath(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (!opts.install || installFailed) console.error(`    npm install`);
  console.error(`    npm run dev   # serve locally and iterate`);
}

/** Run `npm install` in `cwd` (inherit stdio). */
function npmInstall(cwd: string): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn("npm", ["install"], { cwd, stdio: "inherit" });
    child.on("close", (code) => resolveCode(code ?? 1));
    child.on("error", () => resolveCode(1));
  });
}
