/**
 * `fastagent add <channel>`: drop a `channels/<kind>.ts` adapter-glue file (+ any companion tool, +
 * `.env.example` vars) into an existing workspace. `add` checks and guides; it never bootstraps a
 * workspace (that is `init`'s job). Each channel's template files live in its own bundle at
 * src/channels/<kind>/scaffold/, read here at scaffold time.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectRuntime } from "../runtime.ts";
import { assertInsideWorkspace } from "../workspace.ts";
import { channelBundleFiles, channelTemplate } from "./templates.ts";
import { exists } from "./init.ts";
import { parseEnvContent } from "../env.ts";
import type { FeishuSubscriptionMode } from "../channels/feishu/setup-mode.ts";

export type ChannelKind = "github" | "telegram" | "slack" | "feishu" | "lark";

/** Group-visibility choice shared by the slack/feishu/lark onboarding flows. Each channel keeps its
 * own channel-level type (`SlackGroupBehavior`, `FeishuGroupBehavior`) — this is the CLI-side value. */
export type GroupBehavior = "context" | "mentions";

/** A resolved group-behavior decision plus whether the author actually chose it (flag or prompt).
 * A defaulted "context" (non-interactive, no flag) must never drive a sensitive-scope write. */
export interface GroupBehaviorChoice {
  behavior: GroupBehavior;
  explicit: boolean;
}

/** An env var a scaffolded channel reads. `generate` = a random-string secret the CLI can pre-fill. */
export interface ChannelEnv {
  name: string;
  hint: string;
  /** Required for the channel to run. Optional values are deployed when present but never gate deploy. */
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
    // `{channel}` / `{tools}` are path placeholders the CLI resolves to the real workspace-relative
    // location (agentDir-aware) — the CLI holds no channel-private filenames.
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
      { name: "SLACK_BOT_TOKEN", hint: "Slack app → rotating Bot User OAuth access token", required: true },
      {
        name: "SLACK_BOT_REFRESH_TOKEN",
        hint: "Slack OAuth bot refresh token (required when token rotation is enabled)",
        required: false,
      },
      {
        name: "SLACK_BOT_TOKEN_EXPIRES_AT",
        hint: "Slack rotating bot access-token expiry (epoch milliseconds)",
        required: false,
      },
      { name: "SLACK_CLIENT_ID", hint: "Slack app OAuth client ID (for bot-token rotation)", required: false },
      {
        name: "SLACK_CLIENT_SECRET",
        hint: "Slack app OAuth client secret (for bot-token rotation)",
        required: false,
      },
      { name: "SLACK_SIGNING_SECRET", hint: "Slack app → Basic Information → App Credentials", required: true },
    ],
    steps: [
      "Slack Bot Token Scopes: app_mentions:read, assistant:write, chat:write, im:history, files:read, files:write, channels:history, groups:history, mpim:history",
      "enable Agents (agent_view) and token rotation; subscribe app_home_opened, app_context_changed, app_mention, message.im, message.channels, message.groups, message.mpim; set Request URL to <public-url>/slack",
      "reinstall the app after changing scopes, then invite it to each channel it should read",
      "the agent can send messages or files by calling the scaffolded {tools}/slack-send.ts tool",
    ],
  },
  // Feishu is the canonical engine/cloud; Lark international reuses its protocol through a degraded
  // compatibility profile. Each remains its own channel KIND: route, env, state, console, onboarding.
  // This table is the webhook setup; continuous mode below selects only App ID/Secret. No `generate`
  // in either: values come FROM the platform. `add feishu` scan-creates the app; Lark lacks that
  // control-plane capability, so `add lark` guides console credential collection.
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
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (the CLI adds it to the app draft when supported); it delivers all group messages so bare managed-thread replies can invoke and other unsummoned discussion can buffer",
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
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (add it manually if Lark's config API fallback was used); it delivers all group messages so bare managed-thread replies can invoke and other unsummoned discussion can buffer",
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
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (the CLI adds it to the app draft when supported); it delivers all group messages so bare managed-thread replies can invoke and other unsummoned discussion can buffer",
      "PUBLISH the app version in the developer console after permission approval — long-connection event subscriptions become active with the published version",
      "edit {channel} — routing policy (the scaffold is already set to WebSocket ingress)",
      "run `fastagent dev` without --tunnel; deployments must keep one process running (no scale-to-zero)",
      "the agent can push messages from scheduled turns via the scaffolded {tools}/feishu-send.ts tool",
    ],
  },
  lark: {
    env: CHANNEL_SCAFFOLDS.lark.env.filter((entry) => ["LARK_APP_ID", "LARK_APP_SECRET"].includes(entry.name)),
    steps: [
      "before publishing: approve the sensitive im:message.group_msg permission for context-aware groups (add it manually if Lark's config API fallback was used); it delivers all group messages so bare managed-thread replies can invoke and other unsummoned discussion can buffer",
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
          ? "group behavior: mention-only — do not grant im:message.group_msg; bare managed-thread replies and group context buffering remain disabled"
          : step,
      ),
    };
  }
  if (kind === "slack" && behavior === "mentions") {
    return {
      env: setup.env,
      steps: [
        "Slack Bot Token Scopes: app_mentions:read, assistant:write, chat:write, im:history, files:read, files:write (no channel/group/mpim history scopes)",
        "enable Agents (agent_view) and token rotation; subscribe app_home_opened, app_context_changed, app_mention, and message.im; set Request URL to <public-url>/slack",
        "group behavior: mention-only — bare managed-thread replies and unsummoned group context remain disabled",
        ...setup.steps.slice(2),
      ],
    };
  }
  return { env: setup.env, steps: setup.steps };
}

/**
 * Append a channel's env vars (commented placeholders + hints) to `.env.example`, so a developer who
 * copies it to `.env` finds the vars already there. No-op when there is no `.env.example` or the block
 * is already present. Placeholders only — no real secret lands in the committable template.
 */
export async function appendChannelEnv(
  dir: string,
  kind: ChannelKind,
  ingress: FeishuSubscriptionMode = "webhook",
): Promise<boolean> {
  const file = join(dir, ".env.example");
  let current: string;
  try {
    current = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  const marker = `# --- ${kind} channel ---`;
  if (current.includes(marker)) return false;
  // Hint on its OWN line above the placeholder (like the base env.example template) — never inline
  // after `=`: loadEnvFile does not strip trailing comments, so an uncommented `KEY=   # hint` (or a
  // value pasted before the `#`) would carry the hint text into the parsed value.
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
}

/** Whether `.env` content carries a non-empty ACTIVE value for `name` — decided by THE .env parser
 *  ({@link parseEnvContent}), not a re-implementation, so this check can never disagree with what
 *  `loadEnvFile` will actually read (a missed match here would append a second assignment that
 *  last-wins over the user's working secret). */
function hasActiveEnvValue(content: string, name: string): boolean {
  return (parseEnvContent(content).get(name)?.trim() ?? "") !== "";
}

function mentionsEnvName(content: string, name: string): boolean {
  return content.split("\n").some((line) => new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(line));
}

/**
 * Append generated channel secrets to the run-root `.env` (never `.env.example`) after the CLI has
 * verified that `.env` is gitignored. Existing non-empty values are kept — EXCEPT the names listed in
 * `overwrite`: those are authoritative (e.g. the credentials of an app `add feishu` JUST minted —
 * skipping them for a stale value would silently discard a fresh, unrecoverable secret). Manual values
 * (e.g. TELEGRAM_BOT_TOKEN from BotFather) are added only as commented placeholders, so the file is
 * ready to edit while no fake secret is committed to the user's mental model.
 */
export async function appendChannelDotEnv(
  dir: string,
  kind: ChannelKind,
  generated: Record<string, string>,
  overwrite: readonly string[] = [],
  ingress: FeishuSubscriptionMode = "webhook",
): Promise<DotEnvWriteResult> {
  const file = join(dir, ".env");
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
      // An ACTIVE but EMPTY assignment already in the file (an uncommented, unfilled placeholder from
      // `cp .env.example .env`) must be replaced IN PLACE: a new line written anywhere else either loses
      // to it or wins by position under last-wins — both silently. Replace the LAST occurrence (the one
      // the parser would honor). Line-level match uses THE parser, never a hand regex.
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
      // Hint above, never inline after `=` — see appendChannelEnv (this IS the file loadEnvFile reads).
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
      // A marker already present (e.g. a .env copied from .env.example) — slot the new lines under it
      // instead of orphaning them at the end of the file.
      await writeFile(file, current.replace(marker, `${marker}\n${lines.join("\n")}`));
    } else {
      const prefix = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      await appendFile(file, `${prefix}${marker}\n${lines.join("\n")}\n`);
    }
  }
  return { written, alreadySet };
}

/** The path `add <kind>` scaffolds to. */
function channelPath(dir: string, kind: ChannelKind): string {
  return join(dir, "channels", `${kind}.ts`);
}

/** Whether a channel file already exists — checked before any mutation, so a no-clobber re-add is side-effect-free. */
export async function channelExists(dir: string, kind: ChannelKind): Promise<boolean> {
  return exists(channelPath(dir, kind));
}

/**
 * Scaffold `channels/<kind>.ts` into {@link dir}. Never clobbers an existing file (the glue is
 * authored content). The wx write is the TOCTOU safety net behind {@link channelExists}.
 */
export async function scaffoldChannel(
  dir: string,
  kind: ChannelKind,
  options: { ingress?: FeishuSubscriptionMode; groupBehavior?: GroupBehavior } = {},
): Promise<string> {
  const channelsDir = join(dir, "channels");
  // Don't write through a channels/ symlink that escapes the workspace; an in-workspace one is fine.
  await assertInsideWorkspace(dir, "channels");
  const file = channelPath(dir, kind);
  if (await exists(file)) {
    throw new Error(`${file} already exists — edit it, or remove it to re-scaffold`);
  }
  await mkdir(channelsDir, { recursive: true });
  // `channel.ts` is THE adapter (→ channels/<kind>.ts); any other .ts in the bundle is a companion tool
  // (→ tools/<name>, never clobbering an authored one).
  for (const name of channelBundleFiles(kind)) {
    let content = channelTemplate(kind, name);
    if (name === "channel.ts") {
      if ((kind === "feishu" || kind === "lark") && options.ingress === "websocket") {
        const factory = `${kind}Channel`;
        const wsFactory = `${kind}WebSocketChannel`;
        let configured = content
          .replace(`import { ${factory} }`, `import { ${wsFactory} }`)
          .replace(`export default ${factory}({`, `export default ${wsFactory}({`);
        if (configured === content) throw new Error(`${kind} channel template has no factory anchors`);
        const prefix = kind === "feishu" ? "FEISHU" : "LARK";
        const exportAt = configured.indexOf("export default");
        const importEnd = configured.indexOf("\n\n");
        if (exportAt < 0 || importEnd < 0) throw new Error(`${kind} channel template header anchors are missing`);
        const brand = kind === "feishu" ? "Feishu" : "Lark";
        configured =
          `${configured.slice(0, importEnd)}\n\n` +
          `// ${brand} WebSocket long connection: the process connects OUT to the platform, so no public URL,\n` +
          `// Verification Token, Encrypt Key, or --tunnel is needed. In Events & Callbacks choose long\n` +
          `// connection, subscribe im.message.receive_v1, then publish the app version. Keep one process\n` +
          `// running in production: scale-to-zero/App Sleeping would disconnect ingress.\n` +
          configured.slice(exportAt);
        configured = configured
          .split("\n")
          .filter(
            (line) =>
              !line.includes(`verificationToken: process.env.${prefix}_VERIFICATION_TOKEN`) &&
              !line.includes(`encryptKey: process.env.${prefix}_ENCRYPT_KEY`),
          )
          .join("\n");
        content = configured;
      }
      if (kind === "slack" && options.groupBehavior === "mentions") {
        const configured = content.replace('groupBehavior: "context"', 'groupBehavior: "mentions"');
        if (configured === content) throw new Error("slack channel template has no groupBehavior anchor");
        content = configured;
      }
      await writeFile(file, content, { flag: "wx" });
      continue;
    }
    const toolFile = join(dir, "tools", name);
    if (!(await exists(toolFile))) {
      await mkdir(join(dir, "tools"), { recursive: true });
      await writeFile(toolFile, content, { flag: "wx" });
    }
  }
  return file;
}

/**
 * Verify the workspace is ready to host a channel: an ESM package.json that declares
 * `@fastagent-sh/fastagent` (the channel file imports it). `add` checks and guides, never bootstraps — that
 * is `init`'s job.
 */
export async function assertChannelReady(dir: string): Promise<void> {
  const pkgPath = join(dir, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // `dir` is where the kit lives (agentDir when set) — "run init" is only the right advice when no
      // workspace exists yet; a kit missing its manifest (e.g. a --minimal init) needs the manifest, not init.
      throw new Error(
        `${dir}: no package.json — a channel adapter is code and needs the kit's own manifest. ` +
          `Run \`fastagent init\` for a fresh workspace, or add a package.json with @fastagent-sh/fastagent there ` +
          `(a --minimal init has none)`,
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
