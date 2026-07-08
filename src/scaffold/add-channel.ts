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

export type ChannelKind = "github" | "telegram";

/** An env var a scaffolded channel reads. `generate` = a random-string secret the CLI can pre-fill. */
export interface ChannelEnv {
  name: string;
  hint: string;
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
        generate: true,
      },
    ],
    steps: [
      "edit channels/github.ts — map events to intents in on()",
      "add the webhook in your repo (Settings → Webhooks): Payload URL = <public-url>/webhook, content type application/json",
    ],
  },
  telegram: {
    env: [
      { name: "TELEGRAM_BOT_TOKEN", hint: "from @BotFather → /newbot" },
      { name: "TELEGRAM_SECRET_TOKEN", hint: "any random string; verifies inbound updates", generate: true },
    ],
    steps: [
      "edit channels/telegram.ts — customise routing with route() (optional; the defaults already work)",
      "the agent can send files back by calling the scaffolded tools/telegram-send.ts tool",
    ],
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
  // `channel.ts` is THE adapter (→ channels/<kind>.ts); any other .ts in the bundle is a companion tool
  // (→ tools/<name>, never clobbering an authored one).
  for (const name of channelBundleFiles(kind)) {
    const content = channelTemplate(kind, name);
    if (name === "channel.ts") {
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
      // `dir` is where the kit lives (agentDir when set) — "run init" is only the right advice when no
      // workspace exists yet; a kit missing its manifest (e.g. a --minimal init) needs the manifest, not init.
      throw new Error(
        `${dir}: no package.json — a channel adapter is code and needs the kit's own manifest. ` +
          `Run \`fastagent init\` for a fresh workspace, or add a package.json with @kid7st/fastagent there ` +
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
  if (typeof pkg.dependencies?.["@kid7st/fastagent"] !== "string") {
    const add =
      detectRuntime(dir, pkg).runtime === "bun" ? "bun add @kid7st/fastagent" : "npm install @kid7st/fastagent";
    throw new Error(`${pkgPath}: @kid7st/fastagent is not a dependency — run \`${add}\` (the channel file imports it)`);
  }
}
