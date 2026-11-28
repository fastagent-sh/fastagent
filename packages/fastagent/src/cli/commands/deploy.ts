/**
 * `fastagent deploy init <target>` and `fastagent deploy check`: prepare an agent directory for a host (writing its
 * container and declarative platform files without running any remote deploy) and verify before deploying that the
 * definition loads and the build context leaks no local secrets or state.
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyArtifactPlan, planArtifacts } from "../../deploy/artifacts.ts";
import { type ContainerTarget, STORAGE_DIR, containerArtifacts } from "../../deploy/container.ts";
import { checkContainer, checkDeploy } from "../../deploy/preflight.ts";
import {
  BUILTIN_DEPLOY_TARGETS,
  type BuiltinDeployTarget,
  composeFileContent,
  dockerImageName,
  flyAppName,
  flyConfigContent,
  targetContainerSpec,
} from "../../deploy/targets.ts";
import { exists } from "../../paths.ts";
import { agentDirOrExit, errorPrefix, failStartup, failUsage } from "../fail.ts";

export interface DeployInitOptions {
  force?: boolean;
}

export interface DeployCheckOptions {
  json?: boolean;
}

type ContainerWrite = { ok: false; gate: string } | { ok: true; name: string; port: number };

async function writeContainer(agentDir: string, target: ContainerTarget, force: boolean): Promise<ContainerWrite> {
  const checked = await checkContainer({ agentDir, force, target });
  if (!checked.ok) return checked;
  for (const m of checked.messages) console.error(`[fastagent] ${m.level === "note" ? "note" : "warn"}: ${m.text}`);
  await applyArtifactPlan(await planArtifacts(agentDir, containerArtifacts(checked.container), force, target));
  return { ok: true, name: checked.container.name, port: checked.port };
}

/** Write a user-owned platform file once: kept forever once it exists, even under `--force`. */
async function writeOnce(agentDir: string, filename: string, content: string): Promise<void> {
  const path = join(agentDir, filename);
  if (await exists(path)) {
    console.error(`[fastagent] kept ${filename} (yours once written)`);
    return;
  }
  await writeFile(path, content);
  console.error(`[fastagent] wrote ${filename} (yours from now on)`);
}

export async function runDeployInit(target: string, opts: DeployInitOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  if (!(BUILTIN_DEPLOY_TARGETS as readonly string[]).includes(target)) {
    failUsage(`unknown deploy target "${target}" (targets: ${BUILTIN_DEPLOY_TARGETS.join(", ")})`);
  }
  const chosen = target as BuiltinDeployTarget;
  const written = await writeContainer(agentDir, targetContainerSpec(chosen), opts.force === true).catch(failStartup);
  if (!written.ok) failStartup(new Error(`deploy init ${chosen} stopped: ${written.gate}`));
  const { name, port } = written;

  if (chosen === "docker") {
    const image = dockerImageName(name);
    console.log(
      [
        `# Build the image, then run it with a volume at ${STORAGE_DIR} and the agent's values (its model key,`,
        `# FASTAGENT_API_KEY for the Agent API) from a file of your own.`,
        `docker build --pull -t ${image} .`,
        `docker run -d --name ${name} --restart unless-stopped -v ${name}-data:${STORAGE_DIR} --env-file <file> ` +
          `-p ${port}:${port} ${image}`,
      ].join("\n"),
    );
    return;
  }

  if (chosen === "compose") {
    await writeOnce(agentDir, "compose.yml", composeFileContent(port));
    console.log(
      [
        "# Put the agent's values (its model key, FASTAGENT_API_KEY for the Agent API, declared secrets) in prod.env",
        "# (excluded from the image by .dockerignore), then start:",
        "docker compose up -d --build",
      ].join("\n"),
    );
    return;
  }

  if (chosen === "fly") {
    await writeOnce(agentDir, "fly.toml", flyConfigContent(flyAppName(name), port));
    console.log(
      [
        `# Create the Fly app (single machine: --ha=false avoids a second machine contending for ${STORAGE_DIR}),`,
        "# set its secrets, then deploy:",
        "fly launch --copy-config --ha=false --no-deploy",
        "fly secrets set FASTAGENT_API_KEY=<key> <MODEL_API_KEY>=<value>",
        "fly deploy --ha=false",
      ].join("\n"),
    );
    return;
  }

  console.log(
    [
      `# Create a Railway service, attach a persistent volume at ${STORAGE_DIR} (keep 1 replica),`,
      "# enable Serverless (App Sleeping) and the /health check in service settings, set variables, then deploy:",
      "railway init",
      `railway volume add --mount-path ${STORAGE_DIR}`,
      "railway variables --set FASTAGENT_API_KEY=<key> --set <MODEL_API_KEY>=<value>",
      "railway up",
    ].join("\n"),
  );
}

export async function runDeployCheck(opts: DeployCheckOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  const result = await checkDeploy(agentDir).catch(failStartup);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }
  for (const note of result.notes) console.error(`[fastagent] note: ${note}`);
  for (const warning of result.warnings) console.error(`[fastagent] warn: ${warning}`);
  if (result.gate !== undefined) {
    console.error(`${errorPrefix()} ${result.gate}`);
    process.exit(1);
  }
  if (result.leaks.length > 0) {
    for (const leak of result.leaks) console.error(`${errorPrefix()} ${leak}`);
    process.exit(1);
  }
  console.log("ok");
}
