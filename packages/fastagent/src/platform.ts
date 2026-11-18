/**
 * What a platform extension (`@fastagent-sh/agentcore`) builds on, so that what holds for every container is decided in
 * one place: the command an extension adds (`fastagent <name>`), the portable container it writes for its platform,
 * the check that an image ships none of this machine's secrets, and the build its container opens.
 */
import { applyArtifactPlan, planArtifacts } from "./deploy/artifacts.ts";
import { buildContextPaths, checkKeptIgnoreFiles, shippedWithoutIgnoreFile } from "./deploy/build-context.ts";
import { type ContainerTarget, containerArtifacts } from "./deploy/container.ts";
import { checkContainer } from "./deploy/preflight.ts";
import { resolveAuthPath } from "./harnesses/models/credentials.ts";
import { type AgentDefinition, assertDefinition, definitionSecrets } from "./harnesses/pi-durable/definition.ts";
import { loadProjectBuild } from "./harnesses/pi-durable/built.ts";
import { buildDefinitionShape, loadSourceDefinition } from "./harnesses/pi-durable/open.ts";
import { type PostgresDatabase, listPostgresInstances } from "./harnesses/pi-durable/postgres/storage.ts";
import { instanceName } from "./instance-name.ts";
import { selectAgentEnvironment } from "./paths.ts";
import { nextRun } from "./schedule/cron.ts";

export { DATABASE_URL_ENV } from "./paths.ts";
export { Unavailable } from "./unavailable.ts";
import type { DeclaredSecret } from "./declared-secrets.ts";

export type { ExtensionCli } from "./cli/extension.ts";
export type { ContainerTarget } from "./deploy/container.ts";
export type { DeclaredSecret } from "./declared-secrets.ts";

/** One of the definition's schedules, as a platform inspects it without running it. */
export interface ScheduleFact {
  name: string;
  cron: string;
  tz?: string;
}

/** What a platform asks of the agent in `agentDir` before it runs it: its name, its model, the values its code reads. */
export interface AgentFacts {
  /** The definition's name as one path segment: what a platform names the agent's resources after. */
  name: string;
  /** `provider/modelId`, when the configuration sets one. */
  model?: string;
  /** Every value the definition declares (`needs`, its MCP servers' `${VAR}`), with where. */
  secrets: DeclaredSecret[];
  /** Every schedule in `src/schedules/`, validated as a build validates them. */
  schedules: ScheduleFact[];
}

/** The schedules of `definition`, built with stand-ins for any secrets so inspecting them needs none. */
export function definitionSchedules(definition: AgentDefinition): ScheduleFact[] {
  return buildDefinitionShape(assertDefinition(definition), {}).schedules.map(({ name, cron, tz }) => ({
    name,
    cron,
    ...(tz === undefined ? {} : { tz }),
  }));
}

/** The earliest next run across `schedules` strictly after `from`, or `undefined` when none fires again. */
export function earliestScheduleRun(
  schedules: readonly Pick<ScheduleFact, "cron" | "tz">[],
  from: Date = new Date(),
): Date | undefined {
  let earliest: number | undefined;
  for (const s of schedules) {
    const due = nextRun(s.cron, s.tz, from)?.getTime();
    if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due;
  }
  return earliest === undefined ? undefined : new Date(earliest);
}

/** Every instance `agentName` has opened in `database`, or none before the database's tables exist. */
export function listDatabaseInstances(database: PostgresDatabase, agentName: string): Promise<string[]> {
  return listPostgresInstances(database, agentName);
}

export async function agentFacts(agentDir: string): Promise<AgentFacts> {
  const definition = await loadSourceDefinition(agentDir);
  const { model } = definition.config;
  return {
    name: instanceName(definition.name),
    ...(model === undefined ? {} : { model }),
    secrets: definitionSecrets(definition),
    schedules: definitionSchedules(definition),
  };
}

/** What writing the container found: why the agent cannot become one that starts, or what it said and wrote. */
export type ContainerWrite = { ok: false; gate: string } | { ok: true; name: string; port: number };

/**
 * Write the Dockerfile and `.dockerignore` of `target` into `agentDir`, after checking that the image would start and
 * what it would ship. A file the author owns is kept; `force` regenerates only the ones fastagent generated. What the
 * checks found, and each file written or kept, is said on stderr.
 */
export async function writeContainer(
  agentDir: string,
  target: ContainerTarget,
  { force = false }: { force?: boolean } = {},
): Promise<ContainerWrite> {
  // The image is a production instance: its secrets directory is the production one, which the checks keep out of it.
  selectAgentEnvironment("production");
  const checked = await checkContainer({ agentDir, force, target });
  if (!checked.ok) return checked;
  for (const m of checked.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
  await applyArtifactPlan(await planArtifacts(agentDir, containerArtifacts(checked.container), force, target));
  return { ok: true, name: checked.container.name, port: checked.port };
}

/**
 * What the image built from `agentDir` would carry that it must not: this machine's secrets, value files and state,
 * through an ignore file that does not leave them out, or no ignore file at all. Empty when it carries none.
 */
export async function buildContextLeaks(agentDir: string): Promise<string[]> {
  selectAgentEnvironment("production");
  const paths = await buildContextPaths(agentDir, resolveAuthPath(agentDir));
  const unignored = await shippedWithoutIgnoreFile(agentDir, paths);
  if (unignored !== undefined) return [unignored];
  const leaks: string[] = [];
  await checkKeptIgnoreFiles(
    { agentDir, force: false, paths },
    { note: () => {}, warn: () => {}, leak: (text) => void leaks.push(text) },
  );
  return leaks;
}

/** The build in `<agentDir>/dist`, as `fastagent start` opens it: refused when there is none or the project moved on. */
export function loadAgentBuild(agentDir: string): Promise<AgentDefinition> {
  return loadProjectBuild(agentDir, { checkSources: true });
}
