/**
 * What `fastagent docker init` checks before it writes the container: that the agent directory builds into an image
 * that starts, and that the image would carry none of this machine's secrets or state. A finding the image cannot run
 * with stops the command; everything else is a warning or a note.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAuthPath } from "../harnesses/models/credentials.ts";
import { loadSourceDefinition } from "../harnesses/pi-durable/open.ts";
import { INSTANCE_NAME_ENV, instanceName } from "../instance-name.ts";
import { type McpDeclaration, declareMcp, literalCredentialAdvice, literalCredentials } from "../mcp/config.ts";
import { DEPLOYED_ENV, exists } from "../paths.ts";
import { loadRawProgramConfig } from "../program-config.ts";
import { hasLockfile as lockfileIn, listsFastagent, readPackageJson } from "../runtime.ts";
import { DEFAULT_HTTP_PORT } from "../service.ts";
import { buildContextPaths, checkKeptIgnoreFiles } from "./build-context.ts";
import { type ContainerInput, isGeneratedDockerfile } from "./container.ts";

/** A stderr line the CLI prints (`[fastagent] warn: …` / `[fastagent] note: …`). */
interface DeployMessage {
  level: "warn" | "note";
  text: string;
}

/** Where a check says what it found. */
export interface DeployReport {
  note(text: string): void;
  warn(text: string): void;
}

/** The container to write, or why the agent directory cannot become one that starts. */
export type ContainerCheck =
  | { ok: false; gate: string }
  | { ok: true; messages: DeployMessage[]; container: ContainerInput; port: number };

class DeployGate {
  constructor(readonly text: string) {}
}

export async function checkContainer(input: { agentDir: string; force: boolean }): Promise<ContainerCheck> {
  const messages: DeployMessage[] = [];
  const report: DeployReport = {
    note: (text) => void messages.push({ level: "note", text }),
    warn: (text) => void messages.push({ level: "warn", text }),
  };
  try {
    return { ok: true, messages, ...(await gatherFacts(input, report)) };
  } catch (error) {
    if (error instanceof DeployGate) return { ok: false, gate: error.text };
    throw error;
  }
}

async function gatherFacts(
  input: { agentDir: string; force: boolean },
  report: DeployReport,
): Promise<{ container: ContainerInput; port: number }> {
  const { agentDir, force } = input;
  // The image builds the agent (`start` opens `dist/`), and a build needs the project's own manifest and TypeScript.
  if (!(await exists(join(agentDir, "package.json")))) {
    throw new DeployGate(
      `the agent directory has no package.json, and the image builds the agent: \`fastagent build\` needs one with ` +
        `"type": "module" and typescript (\`fastagent init\` writes both)`,
    );
  }
  // The definition the box loads on every start, read here first: one that does not load would build an image that
  // crash-loops.
  const definition = await loadSourceDefinition(agentDir).catch((error: unknown) => {
    throw new DeployGate(`the definition does not load, so the container would not start: ${messageOf(error)}`);
  });
  const { config } = definition;
  if (config.model === undefined) {
    report.warn(
      `no model is set in fastagent.config.ts (\`model: "provider/id"\`): set FASTAGENT_MODEL on the ` +
        `container, or it refuses to start`,
    );
  } else {
    report.note(`model ${config.model}`);
  }

  const rawProgram = await loadRawProgramConfig(agentDir).catch((error: unknown) => {
    throw new DeployGate(`cannot read fastagent.config.ts: ${messageOf(error)}`);
  });
  checkMcp(agentDir, rawProgram.value?.mcpServers, rawProgram.file, report);

  const pkg = await readPackageJson(agentDir);
  const hasLockfile = lockfileIn(agentDir);
  const kept = await keptDockerfile(agentDir);
  if (!hasLockfile) {
    const otherLock = (await exists(join(agentDir, "pnpm-lock.yaml"))) || (await exists(join(agentDir, "yarn.lock")));
    report.warn(
      otherLock
        ? `the generated Dockerfile is npm-based — your pnpm/yarn lockfile is NOT used (build runs ` +
            `\`npm install\`, not reproducible). Edit the Dockerfile for your package manager, or vendor a package-lock.json.`
        : `no package-lock.json — the image build resolves deps at build time (not reproducible). ` +
            "Run `npm install` and commit the lockfile.",
    );
  }
  if (!listsFastagent(pkg)) {
    report.warn(
      `package.json does not list @fastagent-sh/fastagent — the image has no local fastagent to run, so the ` +
        "container fails at start. Add it to dependencies and re-run `npm install`.",
    );
  }
  const paths = await buildContextPaths(agentDir, resolveAuthPath(agentDir));
  await checkKeptIgnoreFiles({ agentDir, force, paths }, report);

  // A shipped .git needs git in the image.
  const needsGit = await exists(join(agentDir, ".git"));
  const name = instanceName(definition.name);
  if (kept !== undefined) checkKeptDockerfile(kept, name, report);
  const container: ContainerInput = {
    name,
    hasLockfile,
    apt: needsGit ? ["git"] : [],
    machineryPaths: paths.machineryPaths,
  };
  return { container, port: DEFAULT_HTTP_PORT };
}

/** A literal value in the program's MCP servers ships in the image; a `${VAR}` reads it from the container instead. */
function checkMcp(agentDir: string, programServers: unknown, programFile: string, report: DeployReport): void {
  let declarations: McpDeclaration[];
  try {
    declarations = declareMcp(programServers, agentDir, programFile);
  } catch (error) {
    throw new DeployGate(messageOf(error));
  }
  for (const literal of literalCredentials(declarations)) {
    report.warn(
      `${literal.file} mcpServers.${literal.server}.${literal.field}.${literal.key} is a literal value, and the image ` +
        `carries it: ${literalCredentialAdvice(literal)} and set that name on the container`,
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The agent's hand-written Dockerfile, which the command keeps; undefined when there is none, or it is generated. */
async function keptDockerfile(agentDir: string): Promise<string | undefined> {
  const path = join(agentDir, "Dockerfile");
  const text = (await exists(path)) ? await readFile(path, "utf8") : undefined;
  return text === undefined || isGeneratedDockerfile(text) ? undefined : text;
}

/**
 * What a KEPT hand-written Dockerfile drops: the build `start` opens, the marker that makes the box a deployed one, and
 * the name its storage belongs to.
 */
function checkKeptDockerfile(dockerfileText: string, name: string, report: DeployReport): void {
  // Without the marker `start` takes no storage (no mount check, no lease, no owner), so a box that lost it runs as a
  // local instance on a disk that is gone at the next restart. Anywhere in an `ENV` instruction, not just first.
  if (!new RegExp(`^\\s*ENV\\s[^\\n]*\\b${DEPLOYED_ENV}[=\\s]`, "m").test(dockerfileText)) {
    report.warn(
      `your Dockerfile does not set ${DEPLOYED_ENV}, and without it the container starts as a local instance: no ` +
        `mount check, no lease, no storage owner. Add \`ENV ${DEPLOYED_ENV}=1\` (see a generated Dockerfile).`,
    );
  } else if (!new RegExp(`^\\s*ENV\\s[^\\n]*\\b${INSTANCE_NAME_ENV}[=\\s]`, "m").test(dockerfileText)) {
    report.warn(
      `your Dockerfile does not set ${INSTANCE_NAME_ENV}, and a deployed container refuses to start without it. Add ` +
        `\`ENV ${INSTANCE_NAME_ENV}=${name}\`, or set it on the container.`,
    );
  }
  if (!/\bfastagent(?:\s+run)?\s+build\b|\bnpm\s+run\s+build\b/.test(dockerfileText)) {
    report.warn(
      `your Dockerfile does not run \`fastagent build\`: \`start\` opens dist/, which a build context that follows ` +
        `.gitignore leaves out. Add \`RUN ./node_modules/.bin/fastagent build\` after copying the agent.`,
    );
  }
}
