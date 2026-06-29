/**
 * `fastagent add <channel>`: drop a `channels/<kind>.ts` adapter-glue file (+ any companion tool, +
 * `.env.example` vars) into an existing workspace. `add` checks and guides; it never bootstraps a
 * workspace (that is `init`'s job). The template content lives in scaffold-templates.ts.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertInsideWorkspace } from "./definition.ts";
import { exists } from "./init.ts";
import { CHANNEL_GITHUB_TS, CHANNEL_TELEGRAM_TS, TELEGRAM_SEND_TOOL_TS } from "./scaffold-templates.ts";

export type ChannelKind = "github" | "telegram";

/** An env var a scaffolded channel reads. `generate` = a random-string secret the CLI can pre-fill. */
export interface ChannelEnv {
  name: string;
  hint: string;
  generate?: boolean;
}

interface ChannelScaffold {
  template: string;
  env: ChannelEnv[];
  /** Channel-specific next-step lines, printed after the env lines and before the `dev` line. */
  steps: string[];
  /** An optional companion tool dropped into `tools/` (e.g. an outbound action the agent calls). */
  tool?: { name: string; template: string };
}

const CHANNEL_SCAFFOLDS: Record<ChannelKind, ChannelScaffold> = {
  github: {
    template: CHANNEL_GITHUB_TS,
    env: [
      {
        name: "GITHUB_WEBHOOK_SECRET",
        hint: "any random string; set the same value in the GitHub webhook",
        generate: true,
      },
    ],
    steps: [
      "edit channels/github.ts — map events to intents in on()",
      "add the webhook in your repo (Settings → Webhooks): Payload URL = <public-url>/webhook, content type application/json",
    ],
  },
  telegram: {
    template: CHANNEL_TELEGRAM_TS,
    env: [
      { name: "TELEGRAM_BOT_TOKEN", hint: "from @BotFather → /newbot" },
      { name: "TELEGRAM_SECRET_TOKEN", hint: "any random string; verifies inbound updates", generate: true },
    ],
    steps: [
      "edit channels/telegram.ts — customise routing with route() (optional; the defaults already work)",
      "the agent can send files back by calling the scaffolded tools/telegram-send.ts tool",
    ],
    tool: { name: "telegram-send", template: TELEGRAM_SEND_TOOL_TS },
  },
};

/** The channel kinds `fastagent add <kind>` can scaffold. */
export const CHANNEL_KINDS = Object.keys(CHANNEL_SCAFFOLDS) as ChannelKind[];

/** The env vars + next-step lines a scaffolded channel needs (for the CLI to print). */
export function channelSetup(kind: ChannelKind): { env: ChannelEnv[]; steps: string[] } {
  const { env, steps } = CHANNEL_SCAFFOLDS[kind];
  return { env, steps };
}

/**
 * Append a channel's env vars (commented placeholders + hints) to `.env.example`, so a developer who
 * copies it to `.env` finds the vars already there. No-op when there is no `.env.example` or the block
 * is already present. Placeholders only — no real secret lands in the committable template.
 */
export async function appendChannelEnv(dir: string, kind: ChannelKind): Promise<boolean> {
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
  const block = `\n${marker}\n${CHANNEL_SCAFFOLDS[kind].env.map((e) => `# ${e.name}=   # ${e.hint}`).join("\n")}\n`;
  await appendFile(file, block);
  return true;
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
export async function scaffoldChannel(dir: string, kind: ChannelKind): Promise<string> {
  const channelsDir = join(dir, "channels");
  // Don't write through a channels/ symlink that escapes the workspace; an in-workspace one is fine.
  await assertInsideWorkspace(dir, "channels");
  const file = channelPath(dir, kind);
  if (await exists(file)) {
    throw new Error(`${file} already exists — edit it, or remove it to re-scaffold`);
  }
  await mkdir(channelsDir, { recursive: true });
  await writeFile(file, CHANNEL_SCAFFOLDS[kind].template, { flag: "wx" });
  // A companion tool (e.g. telegram's outbound send) goes in tools/; never clobber an authored one.
  const tool = CHANNEL_SCAFFOLDS[kind].tool;
  if (tool && !(await exists(join(dir, "tools", `${tool.name}.ts`)))) {
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "tools", `${tool.name}.ts`), tool.template, { flag: "wx" });
  }
  return file;
}

/**
 * Verify the workspace is ready to host a channel: an ESM package.json that declares
 * `@kid7st/fastagent` (the channel file imports it). `add` checks and guides, never bootstraps — that
 * is `init`'s job.
 */
export async function assertChannelReady(dir: string): Promise<void> {
  const pkgPath = join(dir, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${dir}: not a fastagent code workspace (no package.json) — run \`fastagent init\` here first`);
    }
    throw e;
  }
  let pkg: { type?: string; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    throw new Error(`${pkgPath}: invalid JSON`);
  }
  if (pkg.type !== "module") {
    throw new Error(`${pkgPath}: fastagent channels are ESM — set "type": "module"`);
  }
  if (typeof pkg.dependencies?.["@kid7st/fastagent"] !== "string") {
    throw new Error(
      `${pkgPath}: add "@kid7st/fastagent" to dependencies (then \`npm install\`) — the channel file imports it`,
    );
  }
}
