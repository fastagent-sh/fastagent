/**
 * `fastagent init [dir]`: scaffold a runnable agent and install its dependencies. Layout: flags force;
 * otherwise the jurisdiction rule decides (see detectHostSignals) and the reason is printed.
 * Deliberately no prompt — non-interactive executors (coding agents) get a deterministic default they
 * can read and override.
 */
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectHostSignals, nextStepCd, scaffoldWorkspace } from "../../scaffold/init.ts";
import { failStartup, failUsage } from "../fail.ts";

export interface InitOptions {
  minimal: boolean;
  /** false ⇔ `--no-install`. */
  install: boolean;
  flat: boolean;
  agentDir?: string;
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  let agentDir: string | undefined;
  let signals: string[] = [];
  if (opts.agentDir) {
    // Same containment contract loadConfig enforces on config.agentDir: an escaping value would write
    // the kit outside the workspace AND produce a config that can never load — refuse up front.
    // POSIX-normalized: this lands verbatim in the generated config (agentDir: "./a/b") and the persona
    // locator note — a Windows `relative()` would write backslashes into both.
    const rel = relative(dir, resolve(dir, opts.agentDir)).split(sep).join("/");
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      // An invalid flag VALUE is a usage error (exit 2), same class as a value the parser rejects.
      failUsage(`--agent-dir ("${opts.agentDir}") must be a subdirectory of ${dir}`);
    }
    agentDir = `./${rel}`;
  } else if (!opts.flat) {
    signals = await detectHostSignals(dir).catch(failStartup);
    if (signals.length > 0) agentDir = "./agent";
  }

  const { complete, created, skipped, patched, intoNonEmpty, warnings } = await scaffoldWorkspace(dir, {
    minimal: opts.minimal,
    agentDir,
  }).catch(failStartup);
  // The layout reason prints only once the scaffold actually happened — an "already a workspace" refusal
  // must not be preceded by an announced decision that then never takes place.
  if (signals.length > 0) {
    console.error(
      `[fastagent] found ${signals.join(", ")} — an existing toolchain/deploy claims this directory, so the agent kit goes into ./agent (its own namespace; config.agentDir points there). cwd stays this directory. Override: --flat`,
    );
  }
  console.error(
    `[fastagent] initialized ${dir}${complete ? "" : " (minimal)"}${agentDir ? ` — agent kit in ${agentDir}` : ""}`,
  );
  if (created.length > 0) console.error(`  created: ${created.join(", ")}`);
  if (skipped.length > 0) console.error(`  kept existing: ${skipped.join(", ")}`);
  if (patched.length > 0) console.error(`  updated: ${patched.join(", ")} (missing fastagent excludes appended)`);
  if (intoNonEmpty && !agentDir) {
    console.error(
      `  note: scaffolded flat into a non-empty directory (nothing claims it — the directory is the agent); use --agent-dir <name> to put the kit in a subdir instead`,
    );
  }
  for (const w of warnings) console.error(`[fastagent] warn: ${w}`);

  // Install deps only for a complete agent whose package.json we just wrote (a kept one is not ours).
  // The manifest lives with the kit (agentDir when set), so the install runs there — never against a
  // host repo's own package.json.
  const kitDir = resolve(dir, agentDir ?? ".");
  const willInstall = complete && opts.install && created.includes(join(agentDir ?? ".", "package.json"));
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install${agentDir ? ` in ${agentDir}` : ""})…`);
    installFailed = (await npmInstall(kitDir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${kitDir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = nextStepCd(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (complete && (!opts.install || installFailed))
    console.error(`    ${agentDir ? `(cd ${agentDir} && npm install)` : "npm install"}`);
  console.error(`    fastagent dev   # serve locally and iterate`);
  console.error(`    fastagent add skill <owner/repo/path>   # vendor more skills from GitHub`);
}

/** Run `npm install` in `cwd` (inherit stdio). Returns the exit code. */
function npmInstall(cwd: string): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn("npm", ["install"], { cwd, stdio: "inherit" });
    child.on("close", (code) => resolveCode(code ?? 1));
    child.on("error", () => resolveCode(1));
  });
}
