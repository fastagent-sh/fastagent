/**
 * Init: scaffold a runnable fastagent workspace.
 *
 * Default = a COMPLETE agent (instructions + a skill + a code tool): AGENTS.md, a house-style
 * skill, tools/word-count.ts (defineTool), fastagent.config.mjs, package.json (ESM + the
 * @kid7st/fastagent + zod deps), .gitignore. A complete agent is
 * instructions + tools, so that is what `init` produces; the CLI then runs `npm install`.
 *
 * `--minimal` = the markdown-only unit (AGENTS.md + skill + config + .gitignore): zero npm
 * dependencies, no package.json, no install — for a pure prompt+skills agent.
 *
 * Scaffold conventions:
 *   - AGENTS.md is a CLEAN persona (no meta "edit me" text) because it IS the system prompt;
 *     "what to do next" is printed to the console by the CLI, not baked into a file.
 *   - tools/ is auto-discovered (filename = tool name), so the config needs no `tools: []`.
 *   - .gitignore lists `.env` so the "secrets are the user's responsibility" model
 *     (core-design §10.1) is wired up from the first commit (build honors .gitignore).
 *   - .env.example documents the (optional) env knobs and is committable (only `.env` is ignored);
 *     it is all-commented and states the default model uses OAuth (`fastagent login`), not an API key, so
 *     it never implies a key is required.
 *
 * Node composition-root module: writes template files (the CLI handles `npm install`).
 *
 * Scope boundary (deliberate — do not keep hardening past it): init is best-effort atomic for
 * ORDINARY inputs. It guards the common, recoverable cases — never overwrites an existing
 * workspace, preflights non-directory/symlink scaffold parents, and rolls back a partial write.
 * It does NOT defend against every pathological pre-existing target state (TOCTOU, read-only
 * dirs, FIFOs, mid-write disk-full, …): a local scaffolding command recovered by delete-and-retry.
 */
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadRootIgnore } from "./definition.ts";
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

const GITIGNORE = `# secrets — never commit, never ship in the build artifact
.env

# dependencies (reinstalled at deploy)
node_modules/

# fastagent machine state (dev sessions + build output)
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

/** package.json for the complete (code-tool) agent: ESM + the deps a defineTool tool imports.
 *  The @kid7st/fastagent range tracks THIS build's version (0.x caret locks the minor), so a fresh
 *  workspace installs a version that actually has the API/exports it was scaffolded against. */
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

/** The path `add <kind>` scaffolds to. */
function channelPath(dir: string, kind: "github"): string {
  return join(dir, "channels", `${kind}.ts`);
}

/** Whether a channel file already exists — checked BEFORE any package mutation, so a no-clobber
 *  re-add is a zero-side-effect failure (it must not leave dependency/registry writes behind). */
export async function channelExists(dir: string, kind: "github"): Promise<boolean> {
  return exists(channelPath(dir, kind));
}

/**
 * Scaffold `channels/<kind>.ts` into {@link dir}. Only `github` today. Never clobbers an existing
 * file — the `on()` glue is authored content. Returns the written path. (Callers check
 * {@link channelExists} first; the wx write here is the TOCTOU safety net.)
 */
export async function scaffoldChannel(dir: string, kind: "github"): Promise<string> {
  const channelsDir = join(dir, "channels");
  // A symlinked channels/ is served-then-rejected by loadChannels and skipped by the build, so a file
  // written through it (outside the workspace) can neither load nor ship. Require a real directory.
  const st = await lstat(channelsDir).catch(() => undefined);
  if (st?.isSymbolicLink()) {
    throw new Error(`${channelsDir} is a symlink — use a real directory (the build does not follow it)`);
  }
  const file = channelPath(dir, kind);
  if (await exists(file)) {
    throw new Error(`${file} already exists — edit it, or remove it to re-scaffold`);
  }
  await mkdir(channelsDir, { recursive: true });
  await writeFile(file, CHANNEL_GITHUB_TS, { flag: "wx" });
  return file;
}

/**
 * Verify the workspace is ready to host a channel: a package.json that is ESM (`type: "module"`) and
 * declares `@kid7st/fastagent` (the channel file imports it, resolved from the workspace). `add` does
 * NOT bootstrap this — creating package.json, choosing a module type, or ignoring .env is
 * `fastagent init`'s job. Here we only CHECK and guide, never mutate; failures are actionable.
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

  // Preflight scaffold parent dirs (e.g. `skills`, `tools`): a pre-existing NON-directory there
  // would make mkdir fail mid-loop (ENOTDIR) AFTER the first write, leaving a half-scaffold the
  // identity guard then blocks on retry. Detect it BEFORE any write (lstat, not stat: a symlinked
  // parent must be rejected, not followed outside the dir — matches build's no-follow stance).
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
  // ONE rollback scope over all post-write work: any failure removes files written THIS run
  // (guard + wx guarantee they are ours), so scaffoldWorkspace is atomic (retryable on failure).
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

    // Security wiring: a deploy that copies the directory ships secrets unless .gitignore/
    // .fastagentignore exclude them. If a kept .gitignore does not ignore .env, the scaffold's
    // secret line silently did not take effect. Use loadRootIgnore (the same matcher) so the
    // advisory matches what would ship; it can throw on an unreadable ignore file (kept in the
    // rollback scope so such a throw leaves no half-scaffold).
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
