/**
 * Init: scaffold a minimal, runnable fastagent workspace — the lowest-barrier dev unit.
 *
 * The scaffold is markdown-only (zero npm dependencies): AGENTS.md + one example skill +
 * fastagent.config.mjs + .gitignore. It runs immediately under `fastagent dev` once the
 * developer has model credentials. Code-tool agents (a `package.json` + a tool module) are a
 * separate, opt-in step — this command deliberately scaffolds the no-dependency unit so the
 * first run never blocks on `npm install`.
 *
 * Two scaffold conventions worth noting:
 *   - AGENTS.md is kept a CLEAN persona (no meta "edit me" instructions) because it IS the
 *     system prompt; the "what to edit next" guidance is printed to the console instead.
 *   - .gitignore lists `.env` so the "secrets are the user's responsibility" model
 *     (definition.ts / core-design §10.1) is wired up correctly from the first commit —
 *     build honors .gitignore, so a gitignored .env never ships in the artifact.
 *
 * Node composition-root module: writes template files; no engine import beyond the default
 * model string in the config template (folded-M — lift if a second engine ever scaffolds).
 */
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ignore from "ignore";

const AGENTS_MD = `# Assistant

You are a concise, helpful assistant. Answer directly and skip filler.

When the user asks you to write or edit prose, consult the house-style skill first.
`;

const SKILL_MD = `---
name: house-style
description: The house writing style. Consult before writing or editing any prose for the user.
---
# House style

- Prefer short sentences and the active voice.
- Avoid marketing adjectives ("seamless", "powerful", "robust").
- Lead with the answer; put caveats after.
`;

const CONFIG_MJS = `// fastagent.config.mjs — deployment choices only (model / tools / http).
// Your agent's identity and behavior live in AGENTS.md + skills/, never here.
// Model precedence: \`--model\` flag > FASTAGENT_MODEL env > this default.
// Change "model" to a "provider/modelId" you have access to.
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

interface ScaffoldFile {
  rel: string;
  content: string;
}

/** The files init writes, in report order. AGENTS.md + config are guarded (never overwritten). */
const FILES: ScaffoldFile[] = [
  { rel: "AGENTS.md", content: AGENTS_MD },
  { rel: join("skills", "house-style", "SKILL.md"), content: SKILL_MD },
  { rel: "fastagent.config.mjs", content: CONFIG_MJS },
  { rel: ".gitignore", content: GITIGNORE },
];

export interface ScaffoldResult {
  dir: string;
  /** Files written by this run (relative paths). */
  created: string[];
  /** Files that already existed and were kept untouched (e.g. a pre-existing .gitignore). */
  skipped: string[];
  /** True if the target already had content before this run (init into an existing/non-empty dir). */
  intoNonEmpty: boolean;
  /** Non-fatal advisories the caller MUST surface (e.g. a kept .gitignore that does not ignore .env). */
  warnings: string[];
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Scaffold a minimal runnable workspace into {@link dir} (created if missing). Refuses to
 * overwrite an existing agent identity (AGENTS.md or any fastagent.config.*) — that means the
 * dir is already a workspace, and clobbering it would destroy authored content. Other files
 * that already exist (.gitignore, the example skill) are kept, not overwritten.
 */
export async function scaffoldWorkspace(dir: string): Promise<ScaffoldResult> {
  // Guard on the identity files: their presence means "already a workspace". Fail visibly
  // rather than overwrite authored content.
  const configNames = ["fastagent.config.ts", "fastagent.config.js", "fastagent.config.mjs"];
  const conflicts: string[] = [];
  if (await exists(join(dir, "AGENTS.md"))) conflicts.push("AGENTS.md");
  for (const name of configNames) if (await exists(join(dir, name))) conflicts.push(name);
  if (conflicts.length > 0) {
    throw new Error(
      `"${dir}" already has ${conflicts.join(", ")} — init refuses to overwrite an existing workspace`,
    );
  }

  // Was the target non-empty BEFORE we wrote anything? (missing dir = empty). Used to nudge
  // toward `init <name>` (a fresh subdir) when scaffolding into an existing/non-empty dir.
  const intoNonEmpty = (await readdir(dir).catch(() => [] as string[])).length > 0;

  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of FILES) {
    const abs = join(dir, file.rel);
    await mkdir(dirname(abs), { recursive: true });
    try {
      // wx: never clobber. The identity files are guaranteed absent (guard above); the rest
      // (e.g. a pre-existing .gitignore) are kept on EEXIST instead of overwritten.
      await writeFile(abs, file.content, { flag: "wx" });
      created.push(file.rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") skipped.push(file.rel);
      else throw error;
    }
  }

  // Security wiring is the .gitignore's whole job here: `fastagent build` excludes secrets ONLY
  // via .gitignore/.fastagentignore (it does not special-case .env — core-design §10.1). If we
  // KEPT a pre-existing .gitignore that does not ignore .env, the scaffold's secret line silently
  // did not take effect while next-steps still tells the user to create .env → build could ship it.
  // Warn with the exact fix; do NOT silently mutate the user's file (non-destructive contract +
  // §10.1 "security is the user's responsibility; fastagent informs").
  const warnings: string[] = [];
  const gitignore = await readFile(join(dir, ".gitignore"), "utf8").catch(() => "");
  if (!ignore().add(gitignore).ignores(".env")) {
    warnings.push(
      `your .gitignore does not ignore ".env" — add it, or \`fastagent build\` may ship secrets into the artifact`,
    );
  }
  return { dir, created, skipped, intoNonEmpty, warnings };
}
