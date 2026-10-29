/**
 * `fastagent add <channel>`: drop a `src/channels/<kind>.ts` adapter-glue file (+ any companion tool, +
 * `.secrets/.env.example` vars) into an existing agent.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectRuntime } from "../runtime.ts";
import { assertInsideAgentDir, exists } from "../paths.ts";
import { channelBundleFiles, channelTemplate } from "./templates.ts";
import { type ValueWriteResult, writeValues } from "../value-file.ts";
import { envExamplePath } from "../env.ts";
import { FEISHU_AGENT_SCOPES, type FeishuSubscriptionMode } from "../channels/feishu/setup-mode.ts";
import { slackBotScopes } from "../channels/slack/manifest.ts";

export type ChannelKind = "telegram" | "slack" | "feishu" | "lark";

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
  /** Channel instructions with paths and the serving command filled by the CLI. */
  steps: string[];
}

const AGENT_SCOPE_LIST = FEISHU_AGENT_SCOPES.map((entry) => entry.request).join(", ");
const FEISHU_PERMISSION_STEP =
  `before publishing: the app needs ${AGENT_SCOPE_LIST} — \`add feishu\` requests them with the app and names any ` +
  "your tenant withheld (approve those, then publish)";
/** The setting both clouds read, said the same way in `.env.example` and in `add`'s next steps. */
const ingressEnv = (prefix: "FEISHU" | "LARK"): ChannelEnv => ({
  name: `${prefix}_INGRESS`,
  hint: "webhook | websocket — unset, `dev` connects by websocket, and `start` and every deployment receive by webhook",
  required: false,
});
const LARK_PERMISSION_STEP =
  `before publishing: add ${AGENT_SCOPE_LIST} — \`add lark\` checks them and opens the permission page for any that ` +
  "are missing";

const CHANNEL_SCAFFOLDS: Record<ChannelKind, ChannelScaffold> = {
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
      `Slack Bot Token Scopes: ${slackBotScopes().join(", ")}`,
      "enable Agents (agent_view) and leave token rotation OFF (it cannot be turned off again); subscribe app_home_opened, app_context_changed, app_mention, message.im, message.channels, message.groups, message.mpim; set Request URL to <public-url>/slack",
      "reinstall the app after changing scopes, then invite it to each channel it should read",
      "the agent can send messages or files by calling the scaffolded {tools}/slack-send.ts tool",
      "the agent reads the threads of the channel it is asked in via the scaffolded {tools}/slack-threads.ts tool",
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
        hint: "webhook only (`start`, every deployment) — captured by `deploy --run` (console → Events & Callbacks)",
        required: true,
      },
      {
        name: "FEISHU_ENCRYPT_KEY",
        hint: "webhook only; optional but recommended — set one in the console and copy it here",
        required: false,
      },
      ingressEnv("FEISHU"),
    ],
    steps: [
      FEISHU_PERMISSION_STEP,
      "PUBLISH the app version in the developer console after permission approval — the switch to webhook mode takes effect on publish (one click, once ever; no API for it)",
      "edit {channel} — routing policy (the header walks through the console setup, for hand-made apps)",
      "for webhook ingress, run `{serve} --tunnel` locally or `deploy --run` to register the selected app's event Request URL",
      "the agent can push messages from scheduled turns via the scaffolded {tools}/feishu-send.ts tool",
      "the agent reads the threads of the group it is asked in via the scaffolded {tools}/feishu-threads.ts tool",
    ],
  },
  lark: {
    env: [
      { name: "LARK_APP_ID", hint: "developer console → Credentials & Basic Info", required: true },
      { name: "LARK_APP_SECRET", hint: "developer console → Credentials & Basic Info", required: true },
      {
        name: "LARK_VERIFICATION_TOKEN",
        hint: "webhook only (`start`, every deployment) — console → Events & Callbacks; authenticates inbound events",
        required: true,
      },
      {
        name: "LARK_ENCRYPT_KEY",
        hint: "webhook only; optional but recommended — set one in the console and copy it here",
        required: false,
      },
      ingressEnv("LARK"),
    ],
    steps: [
      "finish the console setup: enable Bot and add the required permissions + im.message.receive_v1 event listed in {channel} (do not publish yet)",
      LARK_PERMISSION_STEP,
      "for webhook ingress, run `{serve} --tunnel` and keep it running; if auto-registration reports a config-API 404, manually switch Subscription mode to webhook, set its printed https://…/lark Request URL, save, then create + publish a version",
      "the agent can push messages from scheduled turns via the scaffolded {tools}/lark-send.ts tool",
      "the agent reads the threads of the group it is asked in via the scaffolded {tools}/lark-threads.ts tool",
    ],
  },
};

/** The channel kinds `fastagent add <kind>` can scaffold. */
export const CHANNEL_KINDS = Object.keys(CHANNEL_SCAFFOLDS) as ChannelKind[];

/** Local setup never changes the production app or ingress. */
const deploymentStep = (kind: "feishu" | "lark", pinned: boolean): string =>
  pinned
    ? `run \`{serve}\` (no tunnel needed: it connects by WebSocket); ${kind.toUpperCase()}_INGRESS=websocket is ` +
      "set for this environment; production has its own app and ingress setting"
    : "run `{serve}` (no tunnel needed: it connects by WebSocket); " +
      "`deploy --run` creates a separate production app for webhook";

const websocketSetup = (kind: "feishu" | "lark", pinned: boolean): ChannelScaffold => {
  const prefix = kind.toUpperCase();
  return {
    env: CHANNEL_SCAFFOLDS[kind].env.filter((entry) =>
      [`${prefix}_APP_ID`, `${prefix}_APP_SECRET`, `${prefix}_INGRESS`].includes(entry.name),
    ),
    steps: [
      kind === "feishu" ? FEISHU_PERMISSION_STEP : LARK_PERMISSION_STEP,
      kind === "feishu"
        ? "PUBLISH the app version in the developer console after permission approval — long-connection event subscriptions become active with the published version"
        : "in Events & Callbacks choose long connection, subscribe im.message.receive_v1, then create + publish a version",
      "edit {channel} — routing policy",
      deploymentStep(kind, pinned),
      `the agent can push messages from scheduled turns via the scaffolded {tools}/${kind}-send.ts tool`,
      `the agent reads the threads of the group it is asked in via the scaffolded {tools}/${kind}-threads.ts tool`,
    ],
  };
};

/** The mode-specific env vars + next-step lines a scaffolded channel needs. */
export function channelSetup(
  kind: ChannelKind,
  ingress: FeishuSubscriptionMode = "webhook",
  /** Whether `<PREFIX>_INGRESS` is explicitly set in this environment. */
  pinned = false,
): { env: ChannelEnv[]; steps: string[] } {
  if (ingress !== "websocket" || (kind !== "feishu" && kind !== "lark")) return CHANNEL_SCAFFOLDS[kind];
  return websocketSetup(kind, pinned);
}

/**
 * Append a channel's env vars (commented placeholders + hints) to `.env.example`, so a developer who copies it to
 * `.env` finds the vars already there. Every var the channel can declare, whichever way this machine receives it:
 * the file is what a collaborator or CI fills for a deployment, which receives Feishu/Lark by webhook.
 */
export async function appendChannelEnv(dir: string, kind: ChannelKind): Promise<boolean> {
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
  const block = `\n${marker}\n${CHANNEL_SCAFFOLDS[kind].env.map((e) => `# ${e.hint}\n# ${e.name}=`).join("\n")}\n`;
  await appendFile(file, block);
  return true;
}

/**
 * Append generated channel secrets to the selected environment's value file, and a placeholder for each the channel
 * reads that nothing generated. Existing non-empty values are kept.
 */
export function appendChannelDotEnv(
  dir: string,
  kind: ChannelKind,
  generated: Record<string, string>,
  overwrite: readonly string[] = [],
  ingress: FeishuSubscriptionMode = "webhook",
): Promise<ValueWriteResult> {
  const entries = channelSetup(kind, ingress).env.map(({ name, hint }) => ({
    name,
    hint,
    ...(generated[name] === undefined ? {} : { value: generated[name] }),
  }));
  return writeValues(dir, `${kind} channel`, entries, overwrite);
}

/** The path `add <kind>` scaffolds to. */
function channelPath(dir: string, kind: ChannelKind): string {
  return join(dir, "src", "channels", `${kind}.ts`);
}

/** Whether a channel file already exists — checked before any mutation, so a no-clobber re-add is side-effect-free. */
export async function channelExists(dir: string, kind: ChannelKind): Promise<boolean> {
  return exists(channelPath(dir, kind));
}

/** Scaffold `src/channels/<kind>.ts` into {@link dir}. */
export async function scaffoldChannel(dir: string, kind: ChannelKind): Promise<string> {
  const channelsDir = join(dir, "src", "channels");
  // Don't write through a src/ symlink that escapes the agent dir; one inside it is fine.
  await assertInsideAgentDir(dir, "src");
  const file = channelPath(dir, kind);
  if (await exists(file)) {
    throw new Error(`${file} already exists — edit it, or remove it to re-scaffold`);
  }
  await mkdir(channelsDir, { recursive: true });
  await writeFile(file, channelTemplate(kind, "channel.ts"), { flag: "wx" });
  return file;
}

/** The bundle's companion tools (every `.ts` beside `channel.ts` → `src/tools/<name>`). */
export async function scaffoldCompanionTools(dir: string, kind: ChannelKind): Promise<string[]> {
  const written: string[] = [];
  for (const name of channelBundleFiles(kind)) {
    if (name === "channel.ts") continue; // the channel, not a tool
    const file = join(dir, "src", "tools", name);
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
          `Add a package.json declaring @fastagent-sh/fastagent there (\`init\` scaffolds one), ` +
          `or create a fresh agent with \`fastagent init <dir>\``,
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
