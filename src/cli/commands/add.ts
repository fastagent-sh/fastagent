/**
 * `fastagent add <channel>|skill` — scaffold channel glue (`src/channels/<kind>.ts`) or vendor an Agent Skills skill.
 * A channel changes the program only: its platform app, and the values of the instance that runs
 * it, are `channels setup`'s.
 */
import { join, relative, resolve } from "node:path";
import { shellArg } from "../../shell-arg.ts";
import { enterAgentEnv } from "../../env.ts";
import { SECRETS_DIRNAME, displayPath } from "../../paths.ts";
import { detectRuntime, readPackageJson } from "../../runtime.ts";
import {
  type ChannelKind,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
  scaffoldCompanionTools,
} from "../../scaffold/add-channel.ts";
import { vendorSkill } from "../../scaffold/vendor-skill.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";

export interface AddChannelOptions {
  /** `--json`: the outcome as one JSON object on stdout. */
  json?: boolean;
}

/**
 * `add <channel>`: the program only. It writes the channel file and its tools and names the
 * values they read in `.secrets/.env.example`; it asks nothing and creates no app. The app, and the values of the
 * instance that runs it, are `channels setup`'s.
 */
export async function runAddChannel(kind: ChannelKind, dirArg: string, opts: AddChannelOptions): Promise<void> {
  const target = agentDirOrExit(resolve(dirArg));
  const agentFromCwd = displayPath(process.cwd(), target);
  const inAgent = (p: string): string => (agentFromCwd === undefined ? p : join(agentFromCwd, p));
  const file = join(target, "src", "channels", `${kind}.ts`);
  const created: string[] = [];
  await (async () => {
    if (await channelExists(target, kind)) {
      console.error(`[fastagent] ${inAgent(relative(target, file))} already exists — keeping it`);
    } else {
      await assertChannelReady(target);
      await scaffoldChannel(target, kind);
      created.push(inAgent(relative(target, file)));
      console.error(`[fastagent] created ${inAgent(relative(target, file))}`);
    }
    // Companion tools are the package's, not authored glue.
    for (const tool of await scaffoldCompanionTools(target, kind)) {
      created.push(inAgent(relative(target, tool)));
      console.error(`[fastagent] wrote ${inAgent(relative(target, tool))}`);
    }
    if (await appendChannelEnv(target, kind)) {
      console.error(`[fastagent] added ${kind} env vars to ${inAgent(join(SECRETS_DIRNAME, ".env.example"))}`);
    }
  })().catch(failStartup);
  const install =
    detectRuntime(target, await readPackageJson(target)).runtime === "bun" ? "bun install" : "npm install";
  const next = [
    `${agentFromCwd === undefined ? install : `(cd ${agentFromCwd} && ${install})`}   # if @fastagent-sh/fastagent is not installed yet`,
    `fastagent channels setup ${kind}${agentFromCwd === undefined ? "" : ` ${shellArg(agentFromCwd)}`}   # creates the app and asks for its credentials`,
    `edit ${inAgent(relative(target, file))} — customise routing with route() (optional; the defaults already work)`,
    ...channelSetup(kind).steps.map((line) => line.replace("{tools}", inAgent(join("src", "tools")))),
    "fastagent dev",
  ];
  console.error("  next steps:");
  for (const line of next) console.error(`    ${line}`);
  if (opts.json) console.log(JSON.stringify({ status: "done", created, next_steps: next }, null, 2));
  process.exit(0);
}

/** `fastagent add skill <source> [dir]`: vendor an Agent Skills skill into <dir>/skills/<name>/. */
export async function runAddSkill(
  source: string | undefined,
  dirArg: string,
  opts: { update?: boolean },
): Promise<void> {
  const target = agentDirOrExit(resolve(dirArg));
  if (!source) {
    // A missing source is a usage error (exit 2), but the guide is worth more than a bare missing-argument line.
    failUsage(
      `add a skill — two ways:\n` +
        `  1. write your own (vibe): create skills/<name>/SKILL.md with name + description\n` +
        `     frontmatter; it's auto-discovered. No command needed — this is the common path.\n` +
        `  2. vendor an existing Agent Skills skill (copied in, git-tracked):\n` +
        `       fastagent add skill <source> [dir]\n` +
        `     source: a git ref (owner/repo/path, github default), a local path (./x, /abs), or a\n` +
        `             bare name found in your global skill dirs (~/.agents/skills, ~/.pi/agent/skills)\n` +
        `     --update overwrites an existing skill (re-fetch from source); review with git diff`,
    );
  }
  // Skills are agent surface — vendored into the agent dir's `skills/`.
  enterAgentEnv(target); // a git-ref source is a network fetch (giget uses global fetch)
  const { name, description, dest, hasScripts, overwritten } = await vendorSkill(target, source, {
    update: opts.update ?? false,
  }).catch(failStartup);
  console.error(`[fastagent] ${overwritten ? "updated" : "vendored"} skill "${name}" → ${dest}/`);
  if (overwritten) console.error(`  overwrote it — \`git diff ${dest}\` to review, \`git checkout ${dest}\` to revert`);
  if (description) console.error(`  ${description.length > 100 ? `${description.slice(0, 100)}…` : description}`);
  if (hasScripts) {
    console.error(
      `  warn: this skill ships scripts/ (executable code that runs in your agent) — review it before deploying`,
    );
  }
  console.error(`  next: mention "${name}" in SYSTEM.md so the model knows when to use it; then \`fastagent dev\``);
}
