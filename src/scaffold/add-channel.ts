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
    // `{channel}` / `{tools}` are path placeholders the CLI resolves to the real workspace-relative
    // location (agentDir-aware) — the CLI holds no channel-private filenames.
    steps: [
      "edit {channel} — map events to intents in on()",
      "add the webhook in your repo (Settings → Webhooks): Payload URL = <public-url>/webhook, content type application/json",
    ],
  },
  telegram: {
    env: [
      { name: "TELEGRAM_BOT_TOKEN", hint: "from @BotFather → /newbot" },
      { name: "TELEGRAM_SECRET_TOKEN", hint: "any random string; verifies inbound updates", generate: true },
    ],
    steps: [
      "edit {channel} — customise routing with route() (optional; the defaults already work)",
      "the agent can send messages or files back by calling the scaffolded {tools}/telegram-send.ts tool",
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
  // Hint on its OWN line above the placeholder (like the base env.example template) — never inline
  // after `=`: loadEnvFile does not strip trailing comments, so an uncommented `KEY=   # hint` (or a
  // value pasted before the `#`) would carry the hint text into the parsed value.
  const block = `\n${marker}\n${CHANNEL_SCAFFOLDS[kind].env.map((e) => `# ${e.hint}\n# ${e.name}=`).join("\n")}\n`;
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
 * verified that `.env` is gitignored. Existing non-empty values are kept. Manual values (e.g.
 * TELEGRAM_BOT_TOKEN from BotFather) are added only as commented placeholders, so the file is ready to
 * edit while no fake secret is committed to the user's mental model.
 */
export async function appendChannelDotEnv(
  dir: string,
  kind: ChannelKind,
  generated: Record<string, string>,
): Promise<DotEnvWriteResult> {
  const file = join(dir, ".env");
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const alreadySet = CHANNEL_SCAFFOLDS[kind].env.filter((e) => hasActiveEnvValue(current, e.name)).map((e) => e.name);
  const lines: string[] = [];
  const written: string[] = [];
  const contentLines = current.split("\n");
  let replacedInPlace = false;
  for (const e of CHANNEL_SCAFFOLDS[kind].env) {
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
