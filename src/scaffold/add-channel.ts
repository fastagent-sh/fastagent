/**
 * `fastagent add <channel>`: drop a `channels/<kind>.ts` adapter-glue file (+ any companion tool, +
 * `.secrets/.env.example` vars) into an existing agent.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectRuntime } from "../runtime.ts";
import { SECRETS_DIRNAME, assertInsideAgentDir, ensureSecretsDir, exists } from "../paths.ts";
import { baseTemplate, channelBundleFiles, channelTemplate } from "./templates.ts";
import { dotEnvPath, envExamplePath, parseEnvContent } from "../env.ts";
import type { FeishuSubscriptionMode } from "../channels/feishu/setup-mode.ts";

export type ChannelKind = "github" | "telegram" | "slack" | "feishu" | "lark";

/** Group-visibility choice shared by the slack/feishu/lark onboarding flows. */
export type GroupBehavior = "context" | "mentions";

/** A resolved group-behavior decision plus whether the author actually chose it (flag or prompt). */
export interface GroupBehaviorChoice {
  behavior: GroupBehavior;
  explicit: boolean;
}

/** An env var a scaffolded channel reads. */
export interface ChannelEnv {
  name: string;
  hint: string;
  /** Required for the channel to run. */
  required: boolean;
  generate?: boolean;
}

interface ChannelScaffold {
  env: ChannelEnv[];
  /** Channel-specific next-step lines, printed after the env lines and before the `dev` line. */
  steps: string[];
}

const CHANNEL_SCAFFOLDS: Record<ChannelKind, ChannelScaffold> = {
  github: {
    env: [
      {
        name: "GITHUB_WEBHOOK_SECRET",
        hint: "any random string; set the same value in the GitHub webhook",
        required: true,
        generate: true,
      },
    ],
    // `{channel}` / `{tools}` are path placeholders the CLI resolves to the real agent-dir-relative location — the
    // CLI holds no channel-private filenames.
    steps: [
      "edit {channel} — map events to intents in on()",
      "add the webhook in your repo (Settings → Webhooks): Payload URL = <public-url>/webhook, content type application/json",
    ],
  },
  telegram: {
    env: [
      { name: "TELEGRAM_BOT_TOKEN", hint: "from @BotFather → /newbot", required: true },
      {
        name: "TELEGRAM_SECRET_TOKEN",
        hint: "any random string; verifies inbound updates",
        required: true,
        generate: true,
      },
    ],
    steps: [
      "edit {channel} — customise routing with route() (optional; the defaults already work)",
      "the agent can send messages or files back by calling the scaffolded {tools}/telegram-send.ts tool",
    ],
  },
  slack: {
    env: [
      { name: "SLACK_BOT_TOKEN", hint: "Slack app → OAuth & Permissions → Bot User OAuth Token", required: true },
      { name: "SLACK_SIGNING_SECRET", hint: "Slack app → Basic Information → App Credentials", required: true },
    ],
    steps: [
      "Slack Bot Token Scopes: app_mentions:read, assistant:write, chat:write, im:history, files:read, files:write, channels:history, groups:history, mpim:history",
      "enable Agents (agent_view) and leave token rotation OFF (it cannot be turned off again); subscribe app_home_opened, app_context_changed, app_mention, message.im, message.channels, message.groups, message.mpim; set Request URL to <public-url>/slack",
      "reinstall the app after changing scopes, then invite it to each channel it should read",
      "the agent can send messages or files by calling the scaffolded {tools}/slack-send.ts tool",
    ],
  },
  // Feishu is the canonical engine/cloud; Lark international reuses its protocol through a degraded compatibility
  // profile.
  feishu: {
    env: [
      {
        name: "FEISHU_APP_ID",
        hint: "created + written automatically by `add feishu` (console → Credentials & Basic Info)",
        required: true,
      },
      {
        name: "FEISHU_APP_SECRET",
        hint: "created + written automatically by `add feishu` (console → Credentials & Basic Info)",
        required: true,
      },
      {
        name: "FEISHU_VERIFICATION_TOKEN",
        hint: "captured automatically (console → Events & Callbacks)",
        required: true,
      },
      {
        name: "FEISHU_ENCRYPT_KEY",
        hint: "optional but recommended — set one in the console and copy it here",
        required: false,
      },
    ],
    steps: [
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (the CLI adds it to the app draft when supported); it delivers all group messages so bare replies in the agent's own threads can invoke and other unsummoned discussion can buffer. im:message:readonly is requested alongside it so a thread's opening ask can carry the message it quotes; both need the same approval",
      "PUBLISH the app version in the developer console after permission approval — the switch to webhook mode takes effect on publish (one click, once ever; no API for it)",
      "edit {channel} — routing policy (the header walks through the console setup, for hand-made apps)",
      "the event Request URL is auto-registered by `dev --tunnel` / `deploy --run`",
      "the agent can push messages from scheduled turns via the scaffolded {tools}/feishu-send.ts tool",
    ],
  },
  lark: {
    env: [
      { name: "LARK_APP_ID", hint: "developer console → Credentials & Basic Info", required: true },
      { name: "LARK_APP_SECRET", hint: "developer console → Credentials & Basic Info", required: true },
      {
        name: "LARK_VERIFICATION_TOKEN",
        hint: "console → Events & Callbacks; authenticates inbound events",
        required: true,
      },
      {
        name: "LARK_ENCRYPT_KEY",
        hint: "optional but recommended — set one in the console and copy it here",
        required: false,
      },
    ],
    steps: [
      "finish the console setup: enable Bot and add the required permissions + im.message.receive_v1 event listed in {channel} (do not publish yet)",
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (add it manually if Lark's config API fallback was used); it delivers all group messages so bare replies in the agent's own threads can invoke and other unsummoned discussion can buffer. im:message:readonly is requested alongside it so a thread's opening ask can carry the message it quotes; both need the same approval",
      "run `fastagent dev --tunnel` and keep it running; if auto-registration reports a config-API 404, manually switch Subscription mode to webhook, set its printed https://…/lark Request URL, save, then create + publish a version",
      "the agent can push messages from scheduled turns via the scaffolded {tools}/lark-send.ts tool",
    ],
  },
};

/** The channel kinds `fastagent add <kind>` can scaffold. */
export const CHANNEL_KINDS = Object.keys(CHANNEL_SCAFFOLDS) as ChannelKind[];

const WEBSOCKET_SETUPS: Record<"feishu" | "lark", ChannelScaffold> = {
  feishu: {
    env: CHANNEL_SCAFFOLDS.feishu.env.filter((entry) => ["FEISHU_APP_ID", "FEISHU_APP_SECRET"].includes(entry.name)),
    steps: [
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (the CLI adds it to the app draft when supported); it delivers all group messages so bare replies in the agent's own threads can invoke and other unsummoned discussion can buffer. im:message:readonly is requested alongside it so a thread's opening ask can carry the message it quotes; both need the same approval",
      "PUBLISH the app version in the developer console after permission approval — long-connection event subscriptions become active with the published version",
      "edit {channel} — routing policy (the scaffold is already set to WebSocket ingress)",
      "run `fastagent dev` without --tunnel; deployments must keep one process running (no scale-to-zero)",
      "the agent can push messages from scheduled turns via the scaffolded {tools}/feishu-send.ts tool",
    ],
  },
  lark: {
    env: CHANNEL_SCAFFOLDS.lark.env.filter((entry) => ["LARK_APP_ID", "LARK_APP_SECRET"].includes(entry.name)),
    steps: [
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (add it manually if Lark's config API fallback was used); it delivers all group messages so bare replies in the agent's own threads can invoke and other unsummoned discussion can buffer. im:message:readonly is requested alongside it so a thread's opening ask can carry the message it quotes; both need the same approval",
      "in Events & Callbacks choose long connection, subscribe im.message.receive_v1, then create + publish a version",
      "edit {channel} — routing policy (the scaffold is already set to WebSocket ingress)",
      "run `fastagent dev` without --tunnel; deployments must keep one process running (no scale-to-zero)",
      "the agent can push messages from scheduled turns via the scaffolded {tools}/lark-send.ts tool",
    ],
  },
};

/** The mode-specific env vars + next-step lines a scaffolded channel needs. */
export function channelSetup(
  kind: ChannelKind,
  ingress: FeishuSubscriptionMode = "webhook",
  groupBehavior?: GroupBehavior,
): { env: ChannelEnv[]; steps: string[] } {
  const behavior = groupBehavior ?? "context";
  const setup =
    ingress === "websocket" && (kind === "feishu" || kind === "lark")
      ? WEBSOCKET_SETUPS[kind]
      : CHANNEL_SCAFFOLDS[kind];
  if ((kind === "feishu" || kind === "lark") && behavior === "mentions") {
    return {
      env: setup.env,
      steps: setup.steps.map((step) =>
        step.includes("im:message.group_msg")
          ? "group behavior: mention-only — do not grant im:message.group_msg; bare thread replies and group context buffering remain disabled. im:message:readonly is independent of this choice: add it if you want an @mention to carry the message it quotes (without it that quote degrades to a marker)"
          : step,
      ),
    };
  }
  if (kind === "slack" && behavior === "mentions") {
    return {
      env: setup.env,
      steps: [
        "Slack Bot Token Scopes: app_mentions:read, assistant:write, chat:write, im:history, files:read, files:write (no channel/group/mpim history scopes)",
        "enable Agents (agent_view) and leave token rotation OFF (it cannot be turned off again); subscribe app_home_opened, app_context_changed, app_mention, and message.im; set Request URL to <public-url>/slack",
        "group behavior: mention-only — bare thread replies and unsummoned group context remain disabled",
        ...setup.steps.slice(2),
      ],
    };
  }
  return { env: setup.env, steps: setup.steps };
}

/**
 * Append a channel's env vars (commented placeholders + hints) to `.env.example`, so a developer who copies it to
 * `.env` finds the vars already there.
 */
export async function appendChannelEnv(
  dir: string,
  kind: ChannelKind,
  ingress: FeishuSubscriptionMode = "webhook",
): Promise<boolean> {
  const file = envExamplePath(dir);
  let current: string;
  try {
    current = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  const marker = `# --- ${kind} channel ---`;
  if (current.includes(marker)) return false;
  // Hint on its OWN line above the placeholder (like the base env.example template).
  const block = `\n${marker}\n${channelSetup(kind, ingress)
    .env.map((e) => `# ${e.hint}\n# ${e.name}=`)
    .join("\n")}\n`;
  await appendFile(file, block);
  return true;
}

export interface DotEnvWriteResult {
  /** Generated secret vars written as active `KEY=value` lines. */
  written: string[];
  /** Vars already present with a non-empty active value; left untouched and omitted from next steps. */
  alreadySet: string[];
  /** Set when the secrets dir is an operator-chosen one (`FASTAGENT_SECRETS_DIR`) carrying no `.gitignore`. */
  unprotectedSecretsDir?: string;
}

/** Whether `.env` content carries a non-empty ACTIVE value for `name`. */
function hasActiveEnvValue(content: string, name: string): boolean {
  return (parseEnvContent(content).get(name)?.trim() ?? "") !== "";
}

function mentionsEnvName(content: string, name: string): boolean {
  return content.split("\n").some((line) => new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(line));
}

/**
 * Append generated channel secrets to the agent's `.env` (`.secrets/.env` — never `.env.example`) Existing non-empty
 * values are kept.
 */
export async function appendChannelDotEnv(
  dir: string,
  kind: ChannelKind,
  generated: Record<string, string>,
  overwrite: readonly string[] = [],
  ingress: FeishuSubscriptionMode = "webhook",
): Promise<DotEnvWriteResult> {
  const file = dotEnvPath(dir);
  const secretsDir = dirname(file);
  await ensureSecretsDir(secretsDir);
  // THE one exception to "fastagent has no opinion about git": the directory it writes secrets into carries its own
  // `.gitignore`.
  const owned = secretsDir === join(dir, SECRETS_DIRNAME);
  let unprotectedSecretsDir: string | undefined;
  if (owned) {
    // Only EEXIST is tolerable (already protected, or a concurrent writer).
    await writeFile(join(secretsDir, ".gitignore"), baseTemplate("secrets.gitignore"), { flag: "wx" }).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      },
    );
  } else if (!(await exists(join(secretsDir, ".gitignore")))) {
    unprotectedSecretsDir = secretsDir;
  }
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const env = channelSetup(kind, ingress).env;
  const alreadySet = env
    .filter((e) => !overwrite.includes(e.name) && hasActiveEnvValue(current, e.name))
    .map((e) => e.name);
  const lines: string[] = [];
  const written: string[] = [];
  const contentLines = current.split("\n");
  let replacedInPlace = false;
  for (const e of env) {
    if (alreadySet.includes(e.name)) continue;
    const value = generated[e.name];
    if (value !== undefined) {
      // An ACTIVE but EMPTY assignment already in the file (an uncommented, unfilled placeholder from `cp
      // .env.example .env`) must be replaced IN PLACE.
      let idx = -1;
      for (let i = contentLines.length - 1; i >= 0; i--) {
        if (parseEnvContent(contentLines[i] as string).has(e.name)) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        contentLines[idx] = `${e.name}=${value}`;
        replacedInPlace = true;
      } else {
        lines.push(`${e.name}=${value}`);
      }
      written.push(e.name);
    } else if (!mentionsEnvName(current, e.name)) {
      // Hint above, never inline after `=` — see appendChannelEnv (this IS the file loadDotEnv reads).
      lines.push(`# ${e.hint}`, `# ${e.name}=`);
    }
  }
  if (replacedInPlace) {
    current = contentLines.join("\n");
    await writeFile(file, current);
  }
  if (lines.length > 0) {
    const marker = `# --- ${kind} channel ---`;
    if (current.includes(marker)) {
      // A marker already present (e.g. a .env copied from .env.example) — slot the new lines under it instead of
      // orphaning them at the end of the file.
      await writeFile(file, current.replace(marker, `${marker}\n${lines.join("\n")}`));
    } else {
      const prefix = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      await appendFile(file, `${prefix}${marker}\n${lines.join("\n")}\n`);
    }
  }
  return { written, alreadySet, unprotectedSecretsDir };
}

/** The path `add <kind>` scaffolds to. */
function channelPath(dir: string, kind: ChannelKind): string {
  return join(dir, "channels", `${kind}.ts`);
}

/** Whether a channel file already exists — checked before any mutation, so a no-clobber re-add is side-effect-free. */
export async function channelExists(dir: string, kind: ChannelKind): Promise<boolean> {
  return exists(channelPath(dir, kind));
}

/** Scaffold `channels/<kind>.ts` into {@link dir}. */
export async function scaffoldChannel(
  dir: string,
  kind: ChannelKind,
  options: { ingress?: FeishuSubscriptionMode } = {},
): Promise<string> {
  const channelsDir = join(dir, "channels");
  // Don't write through a channels/ symlink that escapes the agent dir; one inside it is fine.
  await assertInsideAgentDir(dir, "channels");
  const file = channelPath(dir, kind);
  if (await exists(file)) {
    throw new Error(`${file} already exists — edit it, or remove it to re-scaffold`);
  }
  await mkdir(channelsDir, { recursive: true });
  // The long-connection variant is its own template FILE, not a transform of the webhook one: the
  // surgery that used to produce it (rename the factory, splice a header, delete the credential
  // lines) had to be re-taught by hand every time the template changed shape, and a missed anchor
  // scaffolded a channel configured for the wrong ingress with nothing failing.
  // Which templates exist is the BUNDLE's fact, asked here rather than assumed from the kind: only
  // feishu/lark ship a long-connection variant today, and a caller asking for one that is missing
  // must get that sentence, not the ENOENT of a path it never named.
  const template = options.ingress === "websocket" ? "channel.websocket.ts" : "channel.ts";
  // CHANNEL templates only: the bundle also holds companion tools (`telegram-send.ts`), and listing
  // one as an available scaffold sends whoever reads this line looking for an ingress that is a tool.
  const available = channelBundleFiles(kind).filter((f) => f.startsWith("channel."));
  if (!available.includes(template)) {
    throw new Error(
      `${kind} has no ${options.ingress ?? "webhook"} scaffold (${template} is not in its bundle) — ` +
        `available: ${available.join(", ")}`,
    );
  }
  await writeFile(file, channelTemplate(kind, template), { flag: "wx" });
  return file;
}

/** The bundle's companion tools (every `.ts` beside `channel.ts` → `tools/<name>`). */
export async function scaffoldCompanionTools(dir: string, kind: ChannelKind): Promise<string[]> {
  const written: string[] = [];
  for (const name of channelBundleFiles(kind)) {
    if (name.startsWith("channel.")) continue; // channel.ts / channel.websocket.ts are the channel, not tools
    const file = join(dir, "tools", name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, channelTemplate(kind, name));
    written.push(file);
  }
  return written;
}

/**
 * Verify the AGENT DIR is ready to host a channel: an ESM package.json that declares `@fastagent-sh/fastagent` (the
 * channel file imports it).
 */
export async function assertChannelReady(dir: string): Promise<void> {
  const pkgPath = join(dir, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // `dir` is the AGENT dir, so `fastagent init` here would nest a second agent inside it.
      throw new Error(
        `${dir}: no package.json — a channel adapter is code and needs the agent's own manifest. ` +
          `Add a package.json declaring @fastagent-sh/fastagent there (a --minimal init writes none), ` +
          `or run \`fastagent init\` in the workspace for a fresh agent`,
      );
    }
    throw e;
  }
  let pkg: { type?: string; packageManager?: unknown; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    throw new Error(`${pkgPath}: invalid JSON`);
  }
  if (pkg.type !== "module") {
    throw new Error(`${pkgPath}: fastagent channels are ESM — set "type": "module"`);
  }
  if (typeof pkg.dependencies?.["@fastagent-sh/fastagent"] !== "string") {
    const add =
      detectRuntime(dir, pkg).runtime === "bun"
        ? "bun add @fastagent-sh/fastagent"
        : "npm install @fastagent-sh/fastagent";
    throw new Error(
      `${pkgPath}: @fastagent-sh/fastagent is not a dependency — run \`${add}\` (the channel file imports it)`,
    );
  }
}
