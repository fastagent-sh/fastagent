/** `fastagent init [dir]`: scaffold a runnable agent and install its dependencies. */
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { DEFAULT_AGENT_DIRNAME, agentsAt, displayPath } from "../../paths.ts";
import { agentDirName, agentDirNameError, scaffoldAgent } from "../../scaffold/init.ts";
import { failStartup, failUsage } from "../fail.ts";

export interface InitOptions {
  /** false ⇔ `--no-install`. */
  install: boolean;
  /** The agent directory's name inside `dir` — undefined = the default. */
  agentDir?: string;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  // A rejected flag VALUE is the usage class, same as one the parser rejects.
  const requested = agentDirName(opts.agentDir);
  const invalid = agentDirNameError(requested);
  if (invalid) failUsage(`--agent-dir "${requested}" ${invalid}`);
  const { agentDir: rel, created } = await scaffoldAgent(dir, { agentDir: requested }).catch(failStartup);
  // The agent dir is where the manifest lives, so the install runs there — never against a surrounding workspace's
  // package.json (its deps are its own concern).
  const agentDir = resolve(dir, rel);
  console.error(`[fastagent] initialized ${dir} — agent in ./${rel}/`);
  console.error(`  created: ${created.join(", ")}`);
  // A second agent beside an existing one is a supported shape, not an accident (an engineer's, a PM's and a content
  // owner's agent can drive one repository), but it changes how this workspace resolves from now on — so say it HERE,
  // at the moment it becomes true, instead of at the next command's refusal.
  const siblings = agentsAt(dir).map((a) => basename(a));
  if (siblings.length > 1) {
    const pick = siblings.includes(DEFAULT_AGENT_DIRNAME)
      ? `\`${DEFAULT_AGENT_DIRNAME}\` answers by default; set FASTAGENT_AGENT=<name> for another`
      : `set FASTAGENT_AGENT=<name> (in your shell or .envrc) to pick one`;
    console.error(`[fastagent] note: ${dir} now holds ${siblings.length} agents (${siblings.join(", ")}) — ${pick}`);
  }
  let installFailed = false;
  if (opts.install) {
    console.error(`[fastagent] installing dependencies (npm install in ${rel})…`);
    installFailed = (await npmInstall(agentDir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${agentDir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = displayPath(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (!opts.install || installFailed) console.error(`    (cd ${rel} && npm install)`);
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
