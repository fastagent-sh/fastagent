/** `fastagent init <dir> [--content <dir>]...`: scaffold a runnable agent and install its dependencies. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { displayPath } from "../../paths.ts";
import { createAgent } from "../../harnesses/pi/authoring.ts";
import { declarationFor } from "../../content/source.ts";
import { failEdit } from "./content.ts";
import { contentLines } from "../content-view.ts";
import { failStartup } from "../fail.ts";

export interface InitOptions {
  /** false ⇔ `--no-install`. */
  install: boolean;
  /** `--content` sources, each a directory the agent works on. */
  content: string[];
}

export async function runInit(dirArg: string, opts: InitOptions): Promise<void> {
  const dir = resolve(dirArg);
  // Every source is read, and every entry checked (by createAgent), BEFORE anything is created.
  const read = await Promise.resolve()
    .then(() => opts.content.map((source) => declarationFor(source, process.cwd())))
    .catch(failStartup);
  // The CLI scaffold carries web access, which needs the `npm install` createAgent runs before the first commit.
  let installFailed = false;
  const { created, content, repository } = await createAgent(dir, {
    content: read.map((source) => source.declaration),
    webAccess: true,
    ...(opts.install
      ? {
          install: async (agentDir: string) => {
            console.error(`[fastagent] installing dependencies (npm install)…`);
            installFailed = (await npmInstall(agentDir)) !== 0;
            if (installFailed) {
              console.error(
                `[fastagent] warn: npm install failed — run it manually in ${agentDir} before \`fastagent dev\``,
              );
            }
          },
        }
      : {}),
  }).catch(failEdit(""));
  console.error(`[fastagent] created ${dir}`);
  for (const note of read.flatMap((source) => source.notes)) console.error(`  ${note}`);
  if (content.length > 0) for (const [label, value] of contentLines(content)) console.error(`  ${label} ${value}`);
  console.error(`  files: ${created.join(", ")}`);
  console.error(`[fastagent] git: ${repository}`);

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
