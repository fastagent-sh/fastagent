/**
 * `fastagent add <channel>|skill` — scaffold channel glue (`channels/<kind>.ts`) or vendor an Agent
 * Skills skill. slack/feishu/lark additionally CREATE OR RESUME the platform app.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isCancel, select } from "@clack/prompts";
import { onboardFeishuCloudApp } from "../add-feishu.ts";
import type { FeishuSubscriptionMode } from "../../channels/feishu/setup-mode.ts";
import { dotEnvPath, loadDotEnv } from "../../env.ts";
import { resolveStateRoot, SECRETS_DIRNAME, isUnderDir, displayPath, exists } from "../../paths.ts";
import { detectRuntime, readPackageJson } from "../../runtime.ts";
import {
  type ChannelKind,
  type GroupBehavior,
  type GroupBehaviorChoice,
  appendChannelDotEnv,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
} from "../../scaffold/add-channel.ts";
import { vendorSkill } from "../../scaffold/vendor-skill.ts";
import { failStartup, failUsage, placementOrExit } from "../fail.ts";

/** `fastagent add <kind> [dir]`: scaffold `channels/<kind>.ts` — the adapter import plus a starter `on()`. */
export async function runAddChannel(
  channelKind: ChannelKind,
  dirArg: string,
  opts: {
    createApp?: boolean;
    ingress?: string;
    groupBehavior?: string;
    onboard?: boolean;
    replaceConfig?: boolean;
    manual?: boolean;
  },
): Promise<void> {
  // The channel (glue + companion tool + secrets) is agent surface — everything lands in the
  // AGENT DIR (`fastagent/`), the same place dev/start discover channels/.
  // Flag conflicts first: a bad combination is a USAGE error (exit 2), and reporting it must not depend
  // on the directory being an agent (a runtime/environment failure, exit 1) — the same order start/tool
  // follow.
  if (opts.replaceConfig && opts.onboard === false) {
    failUsage("--replace-config replaces onboarding credentials; it cannot be combined with --no-onboard");
  }
  if (opts.manual && opts.onboard === false) {
    failUsage("--manual selects how onboarding installs the app; it cannot be combined with --no-onboard");
  }
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  loadDotEnv(target); // onboarding state follows the same FASTAGENT_STATE_DIR as serving/deploy
  // Paths are printed to someone standing in their CWD, usually the workspace, while every file
  // belongs to the AGENT dir — prefix them, or they point at nothing. `displayPath` owns the
  // relative-vs-absolute policy (shared with `init`). The `.env` label names the file actually
  // WRITTEN (FASTAGENT_SECRETS_DIR relocates it, possibly out of the agent), never the default spelling.
  const agentFromCwd = displayPath(process.cwd(), target);
  const inAgent = (p: string): string => (agentFromCwd === undefined ? p : join(agentFromCwd, p));
  const envPath = dotEnvPath(target);
  const envLabel = isUnderDir(envPath, target) ? inAgent(relative(target, envPath)) : envPath;
  // App creation is not a flag — it is what `add feishu` IS (the scan-to-create flow is the default
  // and only path there). The retired --create-app spelling gets a pointer, not silence.
  if (opts.createApp) {
    if (channelKind === "feishu") {
      console.error(`[fastagent] note: --create-app is retired — \`add feishu\` creates the app by default`);
    } else if (channelKind === "lark") {
      failStartup(
        new Error(
          "--create-app is retired — `add lark` now opens the developer console and guides credential setup by default",
        ),
      );
    } else {
      failStartup(new Error("--create-app is retired — app creation is the default behavior of `add feishu`"));
    }
  }
  // Preconditions before the write, so a refusal is side-effect-free. slack/feishu/lark are exceptions:
  // their add is scaffold + ONBOARD THE APP, so an existing scaffold skips the write and continues (a
  // failed/cancelled app or OAuth flow must be re-runnable without hand-deleting authored glue).
  const file = join(target, "channels", `${channelKind}.ts`);
  const slackToolFile = join(target, "tools", "slack-send.ts");
  const slackToolExisted = channelKind === "slack" ? await exists(slackToolFile) : false;
  const existsAlready = await channelExists(target, channelKind).catch(failStartup);
  const ingress = await resolveIngress(channelKind, file, existsAlready, opts.ingress);
  const groupBehavior = await resolveGroupBehavior(channelKind, opts.groupBehavior);
  if (existsAlready) {
    if (channelKind !== "slack" && channelKind !== "feishu" && channelKind !== "lark") {
      failStartup(new Error(`${relative(target, file)} already exists — edit it, or remove it to re-scaffold`));
    }
    console.error(`[fastagent] ${relative(target, file)} already exists — keeping it`);
  } else {
    await assertChannelReady(target).catch(failStartup);
    await scaffoldChannel(target, channelKind, { ingress, groupBehavior: groupBehavior.behavior }).catch(failStartup);
    console.error(`[fastagent] created ${relative(target, file)}`);
    if (channelKind === "slack") {
      console.error(`[fastagent] ${slackToolExisted ? "kept existing" : "created"} ${relative(target, slackToolFile)}`);
    }
  }
  if (await appendChannelEnv(target, channelKind, ingress).catch(failStartup)) {
    console.error(`[fastagent] added ${channelKind} env vars to ${inAgent(join(SECRETS_DIRNAME, ".env.example"))}`);
  }
  // Stateful app onboarding is re-runnable after the scaffold boundary. Slack's internal-app path
  // persists its manifest/OAuth recovery state separately and writes runtime secrets directly.
  let created: Record<string, string> | undefined;
  if (channelKind === "slack" && opts.onboard !== false) {
    const { onboardSlackInternalApp } = await import("../add-slack.ts");
    created = await onboardSlackInternalApp({
      target,
      stateRoot: resolveStateRoot(target),
      groupBehavior,
      replaceConfig: opts.replaceConfig,
      manual: opts.manual,
    })
      .then(() => undefined)
      .catch(failStartup);
  } else if (channelKind === "feishu" || channelKind === "lark") {
    created = await onboardFeishuCloudApp(target, channelKind, ingress, groupBehavior).catch(failStartup);
  }
  const setup = channelSetup(channelKind, ingress, groupBehavior.behavior);
  // Slack's optional env IS its rotation set (refresh token, expiry, client id/secret). A `--manual`
  // app has rotation off and Slack will not let it be turned on later, so "optionally set" would be
  // an invitation to break the channel: bot-auth.ts reads those four as all-or-nothing.
  const env = opts.manual ? setup.env.filter((e) => e.required) : setup.env;
  const steps =
    channelKind === "slack" && opts.onboard !== false
      ? [
          // No line about the Request URL: the `dev --tunnel` line below is the whole instruction, and
          // FastAgent sets that URL itself when the agent first runs (both install modes).
          "invite the app to each channel it should read",
          "the agent can send messages or files by calling the scaffolded {tools}/slack-send.ts tool",
        ]
      : setup.steps;
  const generated = Object.fromEntries(
    env.filter((e) => e.generate).map((e) => [e.name, randomBytes(24).toString("hex")]),
  );
  // Kind-neutral: every channel's generated secrets get the same treatment (github's webhook secret is
  // the same class of value as telegram's); guided Lark credentials ride the same write as overwrites.
  // Feishu's irreversible credentials were already staged inside add-feishu.ts before bootstrap.
  const dotEnv = await appendChannelDotEnv(
    target,
    channelKind,
    { ...generated, ...created },
    Object.keys(created ?? {}),
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
    detectRuntime(target, await readPackageJson(target)).runtime === "bun" ? "bun install" : "npm install";
  console.error(`  next steps:`);
  console.error(
    `    ${agentFromCwd === undefined ? install : `(cd ${agentFromCwd} && ${install})`}                      # if @fastagent-sh/fastagent is not installed yet`,
  );
  for (const e of env) {
    if (dotEnv.alreadySet.includes(e.name)) continue; // the user already has it — nothing to do
    if (dotEnv.written.includes(e.name)) {
      // Written, but its hint may still carry an action (github: paste the same value into the webhook
      // UI) — keep the variable visible instead of silently absorbing it.
      console.error(`    ${e.name} — ${e.generate ? "generated and " : ""}written to ${envLabel}   # ${e.hint}`);
      continue;
    }
    const value = e.generate ? `=${generated[e.name]}` : "";
    const action = e.required ? "set" : "optionally set";
    console.error(`    ${action} ${e.name}${value} in ${envLabel}   # ${e.hint}`);
  }
  // Steps carry `{channel}`/`{tools}` path placeholders (their filenames are the scaffold's private
  // knowledge) — resolve them to the real agent-dir-relative locations here.
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
  } else if (channelKind === "github") {
    console.error(`    fastagent dev --tunnel   # serve locally + print the URL for manual GitHub webhook setup`);
  } else if (channelKind !== "lark") {
    console.error(`    fastagent dev --tunnel   # serve locally + a public URL, auto-registering the webhook`);
  }
  // App-creation flows leave platform/tunnel sockets behind that would otherwise hold the one-shot
  // scaffold command open after all durable boundaries have completed — exit crisply.
  process.exit(0);
}

async function resolveIngress(
  kind: ChannelKind,
  file: string,
  existsAlready: boolean,
  raw: string | undefined,
): Promise<FeishuSubscriptionMode> {
  if (raw !== undefined && raw !== "webhook" && raw !== "websocket") {
    failUsage(`--ingress must be "webhook" or "websocket", got "${raw}"`);
  }
  const requested = raw as FeishuSubscriptionMode | undefined;
  if (kind !== "feishu" && kind !== "lark") return "webhook";

  if (existsAlready) {
    const source = await readFile(file, "utf8").catch(failStartup);
    const factory = source.match(/\b(?:feishu|lark)(WebSocket)?Channel\s*\(/);
    const existing: FeishuSubscriptionMode | undefined = factory
      ? factory[1] === "WebSocket"
        ? "websocket"
        : "webhook"
      : undefined;
    if (!existing) {
      if (!requested) {
        failUsage(
          `${file} uses an unrecognized channel factory — re-run with --ingress webhook|websocket to confirm its mode`,
        );
      }
      return requested;
    }
    if (requested && requested !== existing) {
      failStartup(
        new Error(
          `${file} already selects ${existing} delivery — changing mode is a migration; edit the factory and platform subscription together`,
        ),
      );
    }
    return existing;
  }
  if (requested) return requested;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(
      `[fastagent] no interactive terminal — defaulting ${kind} ingress to webhook (use --ingress websocket)`,
    );
    return "webhook";
  }
  const answer = await select<FeishuSubscriptionMode>({
    message: `How should ${kind === "feishu" ? "Feishu" : "Lark"} deliver events?`,
    // The default must match the non-interactive branch above. Webhook is the cheaper side to be
    // wrong on: its credentials are a superset of websocket's (App ID/Secret plus the Verification
    // Token), and that token has no read API — a websocket app moving to webhook must re-acquire it.
    initialValue: "webhook",
    options: [
      {
        value: "webhook",
        label: "Webhook endpoint",
        hint: "works on every deploy target; supports scale-to-zero; requires a public HTTPS URL",
      },
      {
        value: "websocket",
        label: "WebSocket long connection",
        hint: "no public URL; needs an always-on process (not on AgentCore)",
      },
    ],
  });
  if (isCancel(answer)) failStartup(new Error(`${kind} onboarding cancelled`));
  return answer;
}

async function resolveGroupBehavior(kind: ChannelKind, raw: string | undefined): Promise<GroupBehaviorChoice> {
  if (raw !== undefined && raw !== "context" && raw !== "mentions") {
    failUsage(`--group-behavior must be "context" or "mentions", got "${raw}"`);
  }
  if (kind !== "feishu" && kind !== "lark" && kind !== "slack") return { behavior: "context", explicit: false };
  if (raw !== undefined) return { behavior: raw, explicit: true };
  const defaultBehavior: GroupBehavior = "context";
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(
      `[fastagent] no interactive terminal — assuming ${kind} group behavior ${defaultBehavior}; pass --group-behavior explicitly to override`,
    );
    return { behavior: defaultBehavior, explicit: false };
  }
  const choices = [
    {
      value: "context" as const,
      label: "Context-aware groups (recommended)",
      hint:
        kind === "slack"
          ? "bare replies in the Agent's threads + buffer; requires channel/group/mpim history scopes"
          : "bare replies in the Agent's threads + buffer; im:message.group_msg delivers all group messages",
    },
    {
      value: "mentions" as const,
      label: "Mention-only (least privilege)",
      hint: "only explicit @Agent messages; no group-wide message permission",
    },
  ];
  const answer = await select<GroupBehavior>({
    message: "Choose group-chat behavior",
    initialValue: defaultBehavior,
    options: choices,
  });
  if (isCancel(answer)) failStartup(new Error(`${kind} onboarding cancelled`));
  return { behavior: answer, explicit: true };
}

/** `fastagent add skill <source> [dir]`: vendor an Agent Skills skill into <dir>/skills/<name>/. */
export async function runAddSkill(
  source: string | undefined,
  dirArg: string,
  opts: { update?: boolean },
): Promise<void> {
  const { agentDir: target } = placementOrExit(resolve(dirArg));
  if (!source) {
    // A missing source is a usage error (exit 2), but the guide is worth more than a bare
    // missing-argument line — the common path (writing your own skill) needs no command at all.
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
  console.error(`  next: mention "${name}" in persona.md so the model knows when to use it; then \`fastagent dev\``);
}
