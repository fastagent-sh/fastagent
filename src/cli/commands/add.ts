/**
 * `fastagent add <channel>|skill` — scaffold channel glue (`channels/<kind>.ts`) or vendor an Agent Skills skill.
 * slack/feishu/lark additionally CREATE OR RESUME the platform app.
 */
import { randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { onboardFeishuCloudApp } from "../add-feishu.ts";
import { inspectChannels } from "../../channels/discover.ts";
import { cloudFor } from "../../channels/feishu/cloud.ts";
import { type FeishuSubscriptionMode, feishuIngressFor } from "../../channels/feishu/setup-mode.ts";
import { DEV_SERVE_ENV } from "../../serving-command.ts";
import { dotEnvPath, enterAgentEnv } from "../../env.ts";
import { resolveStateRoot, SECRETS_DIRNAME, isUnderDir, displayPath } from "../../paths.ts";
import { detectRuntime, readPackageJson } from "../../runtime.ts";
import {
  type ChannelKind,
  appendChannelDotEnv,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
  scaffoldCompanionTools,
} from "../../scaffold/add-channel.ts";
import { vendorSkill } from "../../scaffold/vendor-skill.ts";
import { failStartup, failUsage, agentDirOrExit } from "../fail.ts";

/** `fastagent add <kind> [dir]`: scaffold `channels/<kind>.ts` — the adapter import plus a starter `on()`. */
export async function runAddChannel(
  channelKind: ChannelKind,
  dirArg: string,
  opts: { ingress?: string; onboard?: boolean; replaceConfig?: boolean },
): Promise<void> {
  // The channel (glue + companion tool + secrets) is agent surface — everything lands in the AGENT DIR
  // (`fastagent/`), the same place dev/start discover channels/.
  if (opts.replaceConfig && opts.onboard === false) {
    failUsage("--replace-config replaces onboarding credentials; it cannot be combined with --no-onboard");
  }
  const target = agentDirOrExit(resolve(dirArg));
  enterAgentEnv(target); // onboarding state follows the same FASTAGENT_STATE_DIR as serving/deploy
  // Paths are printed to someone standing in their CWD, which may be elsewhere, while every file belongs to the AGENT
  // dir — prefix them, or they point at nothing.
  const agentFromCwd = displayPath(process.cwd(), target);
  const inAgent = (p: string): string => (agentFromCwd === undefined ? p : join(agentFromCwd, p));
  const envPath = dotEnvPath(target);
  const envLabel = isUnderDir(envPath, target) ? inAgent(relative(target, envPath)) : envPath;
  // An existing channel file is authored glue: kept, never rewritten.
  const file = join(target, "channels", `${channelKind}.ts`);
  const existsAlready = await channelExists(target, channelKind).catch(failStartup);
  const { ingress, pinned, setting } = resolveIngress(channelKind, opts.ingress);
  if (existsAlready && setting) await assertChannelReadsSetting(target, channelKind, setting, file);
  if (existsAlready) {
    console.error(`[fastagent] ${relative(target, file)} already exists — keeping it`);
  } else {
    await assertChannelReady(target).catch(failStartup);
    await scaffoldChannel(target, channelKind).catch(failStartup);
    console.error(`[fastagent] created ${relative(target, file)}`);
  }
  // Companion tools are the package's, not authored glue.
  for (const tool of await scaffoldCompanionTools(target, channelKind).catch(failStartup)) {
    console.error(`[fastagent] wrote ${relative(target, tool)}`);
  }
  if (await appendChannelEnv(target, channelKind).catch(failStartup)) {
    console.error(`[fastagent] added ${channelKind} env vars to ${inAgent(join(SECRETS_DIRNAME, ".env.example"))}`);
  }
  // Stateful app onboarding is re-runnable after the scaffold boundary.
  let created: Record<string, string> | undefined;
  if (channelKind === "slack" && opts.onboard !== false) {
    const { onboardSlackInternalApp } = await import("../add-slack.ts");
    created = await onboardSlackInternalApp({
      target,
      stateRoot: resolveStateRoot(target),
      replaceConfig: opts.replaceConfig,
    })
      .then(() => undefined)
      .catch(failStartup);
  } else if ((channelKind === "feishu" || channelKind === "lark") && opts.onboard !== false) {
    created = await onboardFeishuCloudApp(target, channelKind, ingress).catch(failStartup);
  }
  const setup = channelSetup(channelKind, ingress, pinned);
  const env = setup.env;
  const steps =
    channelKind === "slack" && opts.onboard !== false
      ? [
          // No line about the Request URL: the `dev --tunnel` line below is the whole instruction, and FastAgent sets
          // that URL itself when the agent first runs.
          "invite the app to each channel it should read",
          // The tool lines are the scaffold's (one list), whichever path set the app up.
          ...setup.steps.filter((step) => step.includes("{tools}/")),
        ]
      : setup.steps;
  const generated = Object.fromEntries(
    env.filter((e) => e.generate).map((e) => [e.name, randomBytes(24).toString("hex")]),
  );
  // Kind-neutral: every channel's generated secrets get the same treatment.
  const dotEnv = await appendChannelDotEnv(
    target,
    channelKind,
    { ...generated, ...created, ...setting },
    [...Object.keys(created ?? {}), ...Object.keys(setting ?? {})],
    ingress,
  ).catch(failStartup);
  if (dotEnv.unprotectedSecretsDir) {
    console.error(
      `[fastagent] note: ${dotEnv.unprotectedSecretsDir} (FASTAGENT_SECRETS_DIR) now holds a secret and has ` +
        `no .gitignore — that directory is yours, so fastagent will not write one into it. Make sure git ` +
        `does not track what is in there.`,
    );
  }
  if (dotEnv.written.length > 0) {
    console.error(`[fastagent] wrote ${dotEnv.written.join(", ")} to ${envLabel}`);
  }
  const install =
    detectRuntime(target, await readPackageJson(target).catch(failStartup)).runtime === "bun"
      ? "bun install"
      : "npm install";
  console.error(`  next steps:`);
  console.error(
    `    ${agentFromCwd === undefined ? install : `(cd ${agentFromCwd} && ${install})`}                      # if @fastagent-sh/fastagent is not installed yet`,
  );
  for (const e of env) {
    if (dotEnv.alreadySet.includes(e.name)) continue; // the user already has it — nothing to do
    if (dotEnv.written.includes(e.name)) {
      // Written, but its hint may still carry an action — keep the variable visible instead of silently absorbing it.
      console.error(`    ${e.name} — ${e.generate ? "generated and " : ""}written to ${envLabel}   # ${e.hint}`);
      continue;
    }
    const value = e.generate ? `=${generated[e.name]}` : "";
    const action = e.required ? "set" : "optionally set";
    console.error(`    ${action} ${e.name}${value} in ${envLabel}   # ${e.hint}`);
  }
  // Steps carry `{channel}`/`{tools}` path placeholders (their filenames are the scaffold's private knowledge) —
  // resolve them to the real agent-dir-relative locations here.
  for (const s of steps) {
    console.error(
      `    ${s.replace("{channel}", inAgent(relative(target, file))).replace("{tools}", inAgent("tools"))}`,
    );
  }
  if (ingress === "websocket") {
    console.error(`    fastagent dev            # no public URL or tunnel required`);
  } else if (channelKind === "slack") {
    console.error(
      `    fastagent dev --tunnel   # ${opts.onboard === false ? "serve locally + print the URL to paste into the Slack app's Event Subscriptions" : "start the agent — then message it in Slack"}`,
    );
  } else if (channelKind !== "lark") {
    console.error(`    fastagent dev --tunnel   # serve locally + a public URL, auto-registering the webhook`);
  }
  // App-creation flows leave platform/tunnel sockets behind that would otherwise hold the one-shot scaffold command
  // open after all durable boundaries have completed.
  process.exit(0);
}

/**
 * What `add` sets the app up for, and whether it writes the choice down. `--ingress` is the `<PREFIX>_INGRESS`
 * setting itself, written for both commands. Unasked, the app is set up for what `dev` will use, by the channel's own
 * rule: a setting already in the environment (an earlier `--ingress`), else WebSocket (no public URL, no reviewed
 * `patch` scope), which leaves every deployment on webhook for `deploy --run` to prepare.
 */
function resolveIngress(
  kind: ChannelKind,
  raw: string | undefined,
): { ingress: FeishuSubscriptionMode; pinned: boolean; setting?: Record<string, string> } {
  if (raw !== undefined && raw !== "webhook" && raw !== "websocket") {
    failUsage(`--ingress must be "webhook" or "websocket", got "${raw}"`);
  }
  if (kind !== "feishu" && kind !== "lark") return { ingress: "webhook", pinned: false };
  const name = `${cloudFor(kind).envPrefix}_INGRESS`;
  if (raw !== undefined) return { ingress: raw, pinned: true, setting: { [name]: raw } };
  try {
    return {
      ingress: feishuIngressFor(kind, { ...process.env, [DEV_SERVE_ENV]: "1" }),
      pinned: Boolean(process.env[name]?.trim()),
    };
  } catch (error) {
    // A malformed value in the environment: the author's to fix, said as the rule says it.
    return failUsage((error as Error).message);
  }
}

/**
 * A setting only takes effect in a channel file that reads it: one scaffolded before it, or written by hand, names its
 * factory. Writing the setting there, and preparing the app for it, would leave the channel receiving the other way
 * with nothing failing, so the existing file is imported under the requested setting first, the way `deploy` reads
 * a channel's shape, and must take the shape the setting names.
 */
async function assertChannelReadsSetting(
  target: string,
  kind: ChannelKind,
  setting: Record<string, string>,
  file: string,
): Promise<void> {
  Object.assign(process.env, setting); // the value this command writes anyway
  const inspected = await inspectChannels(target).catch(failStartup);
  const failure = inspected.failures.find((entry) => entry.file === file);
  if (failure) failStartup(new Error(`${failure.label} failed to load (${failure.message}) — fix it and re-run`));
  const [[name, value]] = Object.entries(setting) as [[string, string]];
  const wanted = value === "webhook" ? "webhook" : "long-connection";
  const shape = inspected.channels.find((channel) => channel.name === kind)?.ingress;
  if (shape !== wanted) {
    failStartup(
      new Error(
        `${relative(target, file)} receives by ${shape === "webhook" ? "webhook" : "WebSocket"} whatever ${name} ` +
          `says — it names its factory instead of reading the setting, so ${name}=${value} would change nothing ` +
          `but the app. Move the file aside and re-run to scaffold one that reads it, or edit its factory yourself`,
      ),
    );
  }
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
  const { name, description, dest, hasScripts, diagnostics, overwritten } = await vendorSkill(target, source, {
    update: opts.update ?? false,
  }).catch(failStartup);
  console.error(`[fastagent] ${overwritten ? "updated" : "vendored"} skill "${name}" → ${dest}/`);
  if (overwritten) console.error(`  overwrote it — \`git diff ${dest}\` to review, \`git checkout ${dest}\` to revert`);
  if (description) console.error(`  ${description.length > 100 ? `${description.slice(0, 100)}…` : description}`);
  for (const d of diagnostics) console.error(`  warn: ${d.message}`);
  if (hasScripts) {
    console.error(
      `  warn: this skill ships scripts/ (executable code that runs in your agent) — review it before deploying`,
    );
  }
  console.error(
    `  next: mention "${name}" in APPEND_SYSTEM.md so the model knows when to use it; then \`fastagent dev\``,
  );
}
