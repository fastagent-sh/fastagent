/**
 * `fastagent add <channel>`: drop a `src/channels/<kind>.ts` adapter-glue file (+ any companion tool, +
 * `.secrets/.env.example` vars) into an existing agent.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectRuntime } from "../runtime.ts";
import { assertInsideAgentDir, exists } from "../paths.ts";
import { channelBundleFiles, channelTemplate } from "./templates.ts";
import { envExamplePath } from "../value-file.ts";

export type ChannelKind = "telegram" | "slack" | "feishu" | "lark";

/** An env var a scaffolded channel reads. */
interface ChannelEnv {
  name: string;
  hint: string;
  /** Required for the channel to run. */
  required: boolean;
}

interface ChannelScaffold {
  env: ChannelEnv[];
  /** Channel instructions with paths and the serving command filled by the CLI. */
  steps: string[];
}

const CHANNEL_SCAFFOLDS: Record<ChannelKind, ChannelScaffold> = {
  // A channel's app is set up by `channels setup`, which asks for these values; `add` only names them.
  telegram: {
    env: [
      { name: "TELEGRAM_BOT_TOKEN", hint: "from @BotFather → /newbot", required: true },
      { name: "TELEGRAM_SECRET_TOKEN", hint: "webhook only: verifies inbound updates", required: true },
    ],
    steps: ["the agent can send messages or files back by calling the scaffolded {tools}/telegram-send.ts tool"],
  },
  slack: {
    env: [
      { name: "SLACK_BOT_TOKEN", hint: "Install App → Bot User OAuth Token", required: true },
      { name: "SLACK_APP_TOKEN", hint: "connection only: Basic Information → App-Level Tokens", required: true },
      { name: "SLACK_SIGNING_SECRET", hint: "webhook only: Basic Information → Signing Secret", required: true },
    ],
    steps: [
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
        hint: "`channels setup feishu` creates the app (console → Credentials & Basic Info)",
        required: true,
      },
      {
        name: "FEISHU_APP_SECRET",
        hint: "`channels setup feishu` keeps it (console → Credentials & Basic Info)",
        required: true,
      },
      {
        name: "FEISHU_VERIFICATION_TOKEN",
        hint: "webhook only: `channels setup feishu` captures it (console → Events & Callbacks)",
        required: true,
      },
      {
        name: "FEISHU_ENCRYPT_KEY",
        hint: "webhook only; optional but recommended — set one in the console and copy it here",
        required: false,
      },
    ],
    steps: [
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
        hint: "webhook only — console → Events & Callbacks; authenticates inbound events",
        required: true,
      },
      {
        name: "LARK_ENCRYPT_KEY",
        hint: "webhook only; optional but recommended — set one in the console and copy it here",
        required: false,
      },
    ],
    steps: [
      "the agent can push messages from scheduled turns via the scaffolded {tools}/lark-send.ts tool",
      "the agent reads the threads of the group it is asked in via the scaffolded {tools}/lark-threads.ts tool",
    ],
  },
};

/** The channel kinds `fastagent add <kind>` can scaffold. */
export const CHANNEL_KINDS = Object.keys(CHANNEL_SCAFFOLDS) as ChannelKind[];

/** The env vars and next-step lines a scaffolded channel has. */
export function channelSetup(kind: ChannelKind): ChannelScaffold {
  return CHANNEL_SCAFFOLDS[kind];
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
