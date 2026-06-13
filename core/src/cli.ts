#!/usr/bin/env node
/**
 * fastagent CLI — the consumer of fastagent.config.ts (product entry point,
 * replacing hand-written entry scripts).
 *
 *   fastagent dev   [dir] — assemble + serve a local HTTP channel (iteration)
 *   fastagent build [dir] — compile a self-contained artifact (core-design §10.3)
 * Next: `start` (production posture, runs an artifact).
 *
 * Process-level side effects (proxy dispatcher, .env loading) belong here — the CLI
 * is the application entry point.
 */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, install as installUndiciFetch, setGlobalDispatcher } from "undici";
import { createInvokeHandler } from "./channels/http.ts";
import { buildPiArtifact } from "./engines/pi/build.ts";
import { createPiAgentFromWorkspace } from "./engines/pi/create.ts";
import { defaultGlobalSkillPaths, loadAgentDefinition } from "./engines/pi/definition.ts";

function usage(code: number): never {
  console.error(`usage:
  fastagent dev   [dir] [--port N] [--model provider/modelId] [--global-skills]
  fastagent build [dir] [--out dir] [--model provider/modelId] [--global-skills]

  dev    assemble the agent in dir (default .) and serve a local HTTP channel.
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
         --global-skills   also load the machine's global skills (~/.pi/agent/skills,
                           ~/.agents/skills); default is definition-only (dev == deployed)
  build  compile dir into a self-contained, relocatable artifact (default out:
         .fastagent/build): cleaned source tree + skills + manifest, minus
         secrets/node_modules/.git (and anything .gitignore'd). Source is untouched.
         --global-skills   materialize the machine's global skills into the artifact`);
  process.exit(code);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    "global-skills": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) usage(0);

const [command, dirArg] = positionals;
const dir = resolve(dirArg ?? ".");
const globalSkills = values["global-skills"] ?? false;

if (command === "dev") await runDev();
else if (command === "build") await runBuild();
else usage(1);

async function runDev(): Promise<void> {
  // Validate flags before any assembly work: argument errors must fail instantly,
  // not after the startup report. (config's http.port is range-checked by loadConfig.)
  const portFlag = values.port === undefined ? undefined : Number(values.port);
  if (portFlag !== undefined && (!Number.isInteger(portFlag) || portFlag < 0 || portFlag > 65535)) {
    console.error(`invalid --port "${values.port}": must be an integer 0-65535`);
    process.exit(1);
  }
  loadDotEnv(dir);
  // Node's fetch does not honor HTTPS_PROXY by itself; route through the local proxy
  // so blocked providers are reachable (reads HTTP(S)_PROXY/NO_PROXY from the env).
  // install() keeps fetch and the dispatcher on the SAME undici implementation —
  // pi does exactly this (core/http-dispatcher): Node 26's bundled fetch consuming
  // responses through npm undici's dispatcher skips gzip decompression, which turned
  // streamed turns into empty stopReason:"stop" messages (verified live 2026-06-11).
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();

  const { agent, definition, config, configPath, modelSpec } = await createPiAgentFromWorkspace(dir, {
    model: values.model,
    globalSkills,
  }).catch(failStartup);

  console.error(`[fastagent] dir:    ${definition.dir}`);
  console.error(`[fastagent] config: ${configPath ?? "(zero-config)"}`);
  console.error(`[fastagent] model:  ${modelSpec}`);
  console.error(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  const loadedSkills = definition.skills.map((s) => s.name);
  console.error(
    `[fastagent] skills: ${loadedSkills.join(", ") || "(none)"}${globalSkills ? " (incl. global)" : ""}`,
  );
  if (!globalSkills) {
    // Definition-only by default: surface globals that exist on this machine but were
    // NOT loaded, so dropped skills are visible at dev time (not discovered at deploy).
    // A separate scan (dev-only diagnostic); the agent itself stays definition-only.
    const withGlobals = await loadAgentDefinition(dir, { skillPaths: defaultGlobalSkillPaths() }).catch(() => undefined);
    const available = (withGlobals?.skills ?? []).map((s) => s.name).filter((n) => !loadedSkills.includes(n));
    if (available.length > 0) {
      console.error(`[fastagent] ${available.length} global skill(s) available but not loaded: ${available.join(", ")}`);
      console.error(`            use in dev: --global-skills | ship: copy into skills/ (or build --global-skills)`);
    }
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);

  const port = portFlag ?? config.http?.port ?? 8787;
  createServer(createInvokeHandler(agent)).listen(port, () => {
    console.error(`[fastagent] http channel on :${port}`);
    console.error(`  curl -N -X POST localhost:${port}/invoke -d '{"session":"s1","text":"hi"}'`);
  });
}

async function runBuild(): Promise<void> {
  loadDotEnv(dir); // the model may come from FASTAGENT_MODEL in .env
  const outDir = resolve(values.out ?? join(dir, ".fastagent", "build"));
  const { manifest, definition } = await buildPiArtifact(dir, outDir, {
    model: values.model,
    globalSkills,
  }).catch(failStartup);

  console.error(`[fastagent] built:  ${outDir}`);
  console.error(`[fastagent] model:  ${manifest.model}`);
  console.error(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.error(
    `[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}${globalSkills ? " (incl. global)" : ""}`,
  );
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);
}

/** .env (secrets) → process.env. Only a missing file is normal; surface anything else. */
function loadDotEnv(d: string): void {
  try {
    process.loadEnvFile(join(d, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** User-fixable startup problems (missing model / bad config / broken definition) are
 *  thrown as plain `Error` with actionable messages — print just the message. Anything
 *  else (TypeError, non-Error, …) is a bug: keep the full stack visible. */
function failStartup(error: unknown): never {
  if (error instanceof Error && error.constructor === Error) console.error(error.message);
  else console.error(error);
  process.exit(1);
}

function reportDefinitionWarnings(
  collisions: { name: string; winnerPath: string; loserPath: string }[],
  diagnostics: { code: string; message: string; path: string }[],
): void {
  for (const c of collisions) {
    console.error(`[fastagent] warn: skill "${c.name}" collision — using ${c.winnerPath}, ignoring ${c.loserPath}`);
  }
  for (const d of diagnostics) {
    console.error(`[fastagent] warn: ${d.code}: ${d.message} (${d.path})`);
  }
}
