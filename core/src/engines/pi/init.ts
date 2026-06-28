/**
 * Init: scaffold a runnable fastagent workspace. Default = a COMPLETE agent (AGENTS.md, a house-style
 * skill, tools/word-count.ts, fastagent.config.mjs, package.json, .gitignore); `--minimal` is the
 * markdown-only unit (no package.json/tool/install). AGENTS.md is a clean persona because it IS the
 * system prompt; tools/ is auto-discovered; .gitignore lists `.env`.
 *
 * Scope: init is best-effort atomic for ORDINARY inputs — it never overwrites an existing workspace,
 * preflights non-directory scaffold parents, and rolls back a partial write. It does not defend
 * against every pathological target state (TOCTOU, FIFOs, disk-full): recover by delete-and-retry.
 */
import { access, appendFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { type LoadedDefinition, assertInsideWorkspace, loadAgentDefinition, loadRootIgnore } from "./definition.ts";
import { fastagentVersion } from "./version.ts";

/** Identity persona (clean — it is the system prompt). The complete variant references the tool. */
function agentsMd(minimal: boolean): string {
  const toolLine = minimal ? "" : "\nWhen the user asks how long a piece of text is, use the word-count tool.\n";
  return `# Assistant

You are a concise, helpful assistant. Answer directly and skip filler.

When the user asks you to write or edit prose, consult the house-style skill first.
${toolLine}`;
}

const SKILL_MD = `---
name: house-style
description: The house writing style. Consult before writing or editing any prose for the user.
---
# House style

- Prefer short sentences and the active voice.
- Avoid marketing adjectives ("seamless", "powerful", "robust").
- Lead with the answer; put caveats after.
`;

const TOOL_TS = `import { defineTool, z } from "@kid7st/fastagent";

// A code tool: filename (word-count.ts) is the tool name. tools/ is auto-discovered,
// so it needs no registration in fastagent.config. Test it directly with:
//   fastagent tool word-count '{"text":"hello there world"}'
export default defineTool({
  description: "Count the words and characters in a piece of text.",
  input: z.object({ text: z.string().describe("The text to measure") }),
  async execute({ text }) {
    const trimmed = text.trim();
    return { words: trimmed ? trimmed.split(/\\s+/).length : 0, characters: text.length };
  },
});
`;

const CONFIG_MJS = `// fastagent.config.mjs — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity and behavior live in AGENTS.md + skills/ + tools/, never here.
// Model precedence: \`--model\` flag > FASTAGENT_MODEL env > this default.
// Change "model" to a "provider/modelId" you have access to (\`fastagent models\` lists them).
export default {
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
};
`;

const GITIGNORE = `# secrets — never commit (kept out of git and any deploy copy)
.env

# dependencies (reinstalled at deploy)
node_modules/

# fastagent machine state (dev/start sessions)
.fastagent/
`;

// All-commented: copying to .env sets nothing by accident, and every knob is optional. Auth leads
// with `fastagent login` because the default model (openai-codex) is OAuth-only — never imply an API key.
const ENV_EXAMPLE = `# Environment for this agent. Copy to .env (gitignored) and uncomment what you need.
# Everything here is OPTIONAL — the defaults work without a .env.

# --- Model auth ---
# The default model (openai-codex) signs in with OAuth, not an API key: run \`fastagent login\` once.
# Switch to an API-key provider? Set its key here — the variable name is provider-specific
# (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY). Run \`fastagent models\` to see available specs.
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# --- Model selection (overrides fastagent.config) ---
# Precedence: --model flag > FASTAGENT_MODEL > config.
# FASTAGENT_MODEL=openai-codex/gpt-5.5

# --- Serving (fastagent start) ---
# Port precedence: --port > PORT > config.http.port > 8787
# PORT=8787
# Where conversations persist (default: ./fastagent-sessions)
# FASTAGENT_SESSIONS_DIR=./fastagent-sessions
`;

/** package.json for the complete agent: ESM + the deps a defineTool tool imports. The
 *  @kid7st/fastagent range tracks THIS build's version, so a fresh workspace installs an API-matching version. */
function packageJson(name: string, version: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      dependencies: { "@kid7st/fastagent": `^${version}`, zod: "^4.0.0" },
    },
    null,
    2,
  )}\n`;
}

/** Sanitize a directory basename into a valid npm package name (lowercase, safe chars). */
function toPackageName(dir: string): string {
  const base = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "");
  return base || "agent";
}

interface ScaffoldFile {
  rel: string;
  content: string;
}

export interface ScaffoldOptions {
  /** Scaffold the markdown-only unit (no package.json, no tool, no install) instead of a complete agent. */
  minimal?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  /** Whether a complete (code-tool) agent was scaffolded (false for --minimal). */
  complete: boolean;
  /** Files written by this run (relative paths). */
  created: string[];
  /** Files that already existed and were kept untouched (e.g. a pre-existing .gitignore). */
  skipped: string[];
  /** True if the target already had content before this run (init into an existing/non-empty dir). */
  intoNonEmpty: boolean;
  /** Non-fatal advisories the caller MUST surface. */
  warnings: string[];
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** A scaffolded `channels/github.ts`: the third-party adapter import + a starter `on()` to edit. */
const CHANNEL_GITHUB_TS = `import { githubChannel } from "@kid7st/fastagent/github";
import type { ChannelModule } from "@kid7st/fastagent";

// A channel = a third-party ADAPTER (githubChannel: verify + parse + ACK) wired to YOUR on() glue.
// fastagent discovers this file under channels/ and serves the routes it returns. Set
// GITHUB_WEBHOOK_SECRET in .env (a missing secret fails at startup — an empty key would accept forged
// deliveries) and point a GitHub webhook (JSON) at POST /webhook.
const channel: ChannelModule = (agent) => ({
  "POST /webhook": githubChannel(agent, {
    secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    // Map a verified event to the intents the agent acts on (empty array = ignore). Each review is
    // INDEPENDENT and idempotent (it reconciles against the PR's existing comments), so use a
    // distinct per-delivery session (event.deliveryId): overlapping deliveries then run on their
    // own session without a shared-lease drop.
    on: (event) => {
      if (event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload) {
        const { repository, pull_request } = event.payload;
        return [
          {
            session: event.deliveryId,
            text: \`Review pull request #\${pull_request.number} in \${repository.full_name}.\`,
          },
        ];
      }
      return [];
    },
  }),
});

export default channel;
`;

/** A scaffolded `channels/telegram.ts`: the Telegram adapter import + a starter `on()` to edit. */
const CHANNEL_TELEGRAM_TS = `import { telegramChannel } from "@kid7st/fastagent/telegram";
import type { ChannelModule } from "@kid7st/fastagent";

// A channel = a third-party ADAPTER (telegramChannel: verify + run + reply) wired to YOUR on() glue.
// fastagent discovers this file under channels/ and serves the routes it returns. Setup:
//   1. @BotFather → /newbot → put the bot token in TELEGRAM_BOT_TOKEN
//   2. pick a random TELEGRAM_SECRET_TOKEN (verifies that inbound updates really come from Telegram)
//   3. register the webhook once, pointing Telegram at POST /telegram with that secret:
//        curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \\
//          -d url=https://your.host/telegram -d secret_token=$TELEGRAM_SECRET_TOKEN
const channel: ChannelModule = (agent) => ({
  "POST /telegram": telegramChannel(agent, {
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "", // missing → fails at startup (would accept forged updates)
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",       // used to send the agent's reply back to the chat
    // Map a verified update to the intents the agent acts on (empty array = ignore). session per
    // (chat, thread) gives each conversation its own multi-turn memory; chatId is where the reply
    // goes. Auto-adapts: Threaded Mode supplies message_thread_id (own session + reply in-thread); a
    // linear chat has none and falls back to one session per chat.
    on: (update) => {
      const m = update.message;
      if (!m?.text) return [];
      const session = m.message_thread_id ? \`\${m.chat.id}:\${m.message_thread_id}\` : \`\${m.chat.id}\`;
      return [{ session, text: m.text, chatId: m.chat.id, threadId: m.message_thread_id }];
    },
    // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
    // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
    // full details always go to the server log regardless.
    onError: (failed) => \`⚠️ \${failed.details}\`,
  }),
});

export default channel;
`;

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
    steps: ["edit channels/telegram.ts — map updates to intents in on()"],
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
 * Scaffold `channels/<kind>.ts` into {@link dir}. Never clobbers an existing file (the `on()` glue is
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

/** Derive the destination skill name from a source ref: the last path segment, sans `#ref`. */
function skillNameFromSource(source: string): string {
  const noRef = source.split("#")[0] ?? source;
  return basename(noRef.replace(/\/+$/, ""));
}

/** A local source is an explicit path (./x, ../x, /abs); anything else is a giget ref or a bare name. */
function isLocalSource(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../") || source === "." || isAbsolute(source);
}

/** A bare name (no `/`, no `scheme:`) resolves against the local global skill dirs (see below). */
function isBareName(source: string): boolean {
  return !source.includes("/") && !/^[a-z][a-z0-9+.-]*:/i.test(source);
}

/** Local "global" skill dirs, used ONLY as an add-time vendoring source (a bare `add skill <name>`
 *  copies the match in, git-tracked) — nothing is loaded from here at run time. */
function findGlobalSkillSource(name: string): string | undefined {
  for (const root of [join(homedir(), ".agents", "skills"), join(homedir(), ".pi", "agent", "skills")]) {
    if (existsSync(join(root, name, "SKILL.md"))) return join(root, name);
  }
  return undefined;
}

export interface VendoredSkill {
  /** The skill's real name (from SKILL.md frontmatter, per the Agent Skills spec). */
  name: string;
  description?: string;
  /** Workspace-relative destination (e.g. `skills/pdf`). */
  dest: string;
  /** The skill ships a `scripts/` dir (executable code) — a trust signal for the caller. */
  hasScripts: boolean;
  /** Spec diagnostics for THIS skill from the runtime loader (e.g. name ≠ dir). */
  diagnostics: LoadedDefinition["diagnostics"];
  /** True when an existing skill was overwritten (--update); false for a fresh vendor. */
  overwritten: boolean;
}

/**
 * Vendor an Agent Skills skill into `<workspace>/skills/<name>/` from a giget ref (github default), a
 * local path, or a bare name (resolved against the local global skill dirs). Copy-in, git-tracked.
 * Refuses to overwrite unless `options.update` (then a plain git-tracked overwrite, never a merge).
 * Validates a staging copy with the runtime loader BEFORE replacing, so a bad fetch never destroys an
 * existing skill.
 */
export async function vendorSkill(
  workspaceDir: string,
  source: string,
  options: { update?: boolean } = {},
): Promise<VendoredSkill> {
  const name = skillNameFromSource(source);
  if (name === "" || name === "." || name === "..") {
    throw new Error(`cannot derive a skill name from "${source}" — point at a skill directory (…/skills/<name>)`);
  }
  const skillsDir = join(workspaceDir, "skills");
  const dest = join(skillsDir, name);
  // Refuse to clobber unless --update; the check is side-effect-free, and a git-tracked overwrite is
  // safe (review with `git diff`, undo with `git checkout`).
  const overwritten = existsSync(dest);
  if (overwritten && !options.update) {
    throw new Error(
      `skills/${name} already exists — re-run with --update to overwrite it (git tracks the change), or remove it`,
    );
  }
  await mkdir(skillsDir, { recursive: true });

  // Fetch into a STAGING dir (same filesystem → atomic rename), validate, and only THEN replace dest,
  // so a failed/invalid fetch never destroys an existing skill. The leading "." keeps the loader from
  // treating staging as a skill.
  const staging = join(skillsDir, `.${name}.vendoring`);
  await rm(staging, { recursive: true, force: true }); // clear any leftover from a prior crash
  try {
    if (isLocalSource(source)) {
      const src = resolve(source);
      if (!existsSync(join(src, "SKILL.md"))) {
        throw new Error(`"${source}" has no SKILL.md — an Agent Skills skill is a directory containing SKILL.md`);
      }
      await cp(src, staging, { recursive: true });
    } else if (isBareName(source)) {
      // bare name → vendor from a local global skill dir (add-time copy, not a runtime scan).
      const src = findGlobalSkillSource(source);
      if (!src) {
        throw new Error(
          `no skill "${source}" in your global skill dirs (~/.agents/skills, ~/.pi/agent/skills) — ` +
            `give a git ref (owner/repo/path) or a local path instead`,
        );
      }
      await cp(src, staging, { recursive: true });
    } else {
      // giget defaults a BARE ref to its own template registry, not github — so default the provider to
      // github for a plain `owner/repo/path` (an explicit `github:`/`gh:`/`gitlab:`… scheme is kept).
      // Supports a subdir + #ref, fetched via the tar API (no git binary).
      const ref = /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : `github:${source}`;
      // Lazy import: giget is only needed for a git ref, so the serve path (index.ts → init.ts) and the
      // local/bare-name sources never load it.
      const { downloadTemplate } = await import("giget");
      await downloadTemplate(ref, { dir: staging, force: true });
    }
    if (!existsSync(join(staging, "SKILL.md"))) {
      throw new Error(`"${source}" did not yield a SKILL.md — expected an Agent Skills skill directory`);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }); // failed/invalid: drop staging, leave dest intact
    throw error;
  }
  // Validated. Replace atomically — the old skill survived every failure path above.
  if (overwritten) await rm(dest, { recursive: true, force: true });
  await rename(staging, dest);

  // Report via the runtime loader, matching THIS skill by EXACT directory (a substring match would
  // prefix-pollute a sibling `<name>-x` and break on Windows path separators).
  const def = await loadAgentDefinition(workspaceDir);
  const rel = join("skills", name);
  const skill = def.skills.find((sk) => relative(workspaceDir, dirname(sk.filePath)) === rel);
  return {
    name: skill?.name ?? name,
    description: skill?.description,
    dest: rel,
    hasScripts: existsSync(join(dest, "scripts")),
    diagnostics: def.diagnostics.filter((d) => d.path !== undefined && relative(workspaceDir, dirname(d.path)) === rel),
    overwritten,
  };
}

/**
 * Scaffold a runnable workspace into {@link dir} (created if missing). Default is a complete
 * agent (instructions + skill + a code tool + package.json); `--minimal` is markdown-only.
 * Refuses to overwrite an existing agent identity (AGENTS.md or any fastagent.config.*); other
 * pre-existing files (.gitignore, package.json, the example skill) are kept, not overwritten.
 */
export async function scaffoldWorkspace(dir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const minimal = options.minimal ?? false;
  const files: ScaffoldFile[] = [
    { rel: "AGENTS.md", content: agentsMd(minimal) },
    { rel: join("skills", "house-style", "SKILL.md"), content: SKILL_MD },
    { rel: "fastagent.config.mjs", content: CONFIG_MJS },
    { rel: ".gitignore", content: GITIGNORE },
    { rel: ".env.example", content: ENV_EXAMPLE },
  ];
  if (!minimal) {
    files.push(
      { rel: join("tools", "word-count.ts"), content: TOOL_TS },
      { rel: "package.json", content: packageJson(toPackageName(dir), await fastagentVersion()) },
    );
  }

  // Guard on the identity files: their presence means "already a workspace". Fail visibly
  // rather than overwrite authored content.
  const configNames = ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"];
  const conflicts: string[] = [];
  if (await exists(join(dir, "AGENTS.md"))) conflicts.push("AGENTS.md");
  for (const name of configNames) if (await exists(join(dir, name))) conflicts.push(name);
  if (conflicts.length > 0) {
    throw new Error(`"${dir}" already has ${conflicts.join(", ")} — init refuses to overwrite an existing workspace`);
  }

  // Was the target non-empty BEFORE we wrote anything? (missing dir = empty).
  const intoNonEmpty = (await readdir(dir).catch(() => [] as string[])).length > 0;

  // Preflight scaffold parent dirs: a pre-existing non-directory there would make mkdir fail mid-loop
  // AFTER the first write, leaving a half-scaffold. Detect it before any write (lstat, not stat: a
  // symlinked parent must be rejected, not followed — it would write outside the workspace).
  const parents = new Set<string>();
  for (const file of files) {
    let p = dirname(file.rel);
    while (p !== "." && p !== "") {
      parents.add(p);
      p = dirname(p);
    }
  }
  for (const rel of parents) {
    const st = await lstat(join(dir, rel)).catch(() => undefined);
    if (st && !st.isDirectory()) {
      throw new Error(
        `cannot scaffold: "${rel}" exists and is not a directory (a regular file or symlink) — remove it, or init elsewhere`,
      );
    }
  }

  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  // ONE rollback scope: any failure removes files written THIS run (guard + wx guarantee they are
  // ours), so scaffoldWorkspace is atomic.
  try {
    for (const file of files) {
      const abs = join(dir, file.rel);
      await mkdir(dirname(abs), { recursive: true });
      try {
        await writeFile(abs, file.content, { flag: "wx" }); // wx: never clobber
        created.push(file.rel);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") skipped.push(file.rel);
        else throw error;
      }
    }

    // A deploy that copies the dir ships secrets unless .gitignore/.fastagentignore exclude them. Use
    // loadRootIgnore (the same matcher) so the advisory matches what would ship; a kept .gitignore
    // that doesn't ignore .env means the scaffold's secret line silently didn't take effect.
    const rootIgnore = await loadRootIgnore(dir);
    if (!rootIgnore?.ignores(".env")) {
      warnings.push(
        `your .gitignore/.fastagentignore does not exclude ".env" — add it, or a deploy that copies the directory may ship secrets`,
      );
    }
    // A kept package.json won't carry the tool's deps — the example tool would not resolve.
    if (!minimal && skipped.includes("package.json")) {
      warnings.push(
        `kept your existing package.json — add "@kid7st/fastagent" and "zod" to its dependencies to use code tools`,
      );
    }
  } catch (error) {
    for (const rel of created.reverse()) await rm(join(dir, rel), { force: true }).catch(() => {});
    throw error;
  }
  return { dir, complete: !minimal, created, skipped, intoNonEmpty, warnings };
}
