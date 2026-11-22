/**
 * `fastagent deploy init <target>` and `fastagent deploy check`: prepare an agent directory for a host (writing its
 * container and declarative platform files without running any remote deploy) and verify before deploying that the
 * definition loads and the build context leaks no local secrets or state.
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ContainerTarget, DOCKER_TARGET, STORAGE_DIR } from "../../deploy/container.ts";
import { checkDeploy } from "../../deploy/preflight.ts";
import { exists } from "../../paths.ts";
import { writeContainer } from "../../platform.ts";
import { fastagentVersion } from "../../version.ts";
import { extensionEntry, extensionPackage, runExtension } from "../extension.ts";
import { agentDirOrExit, errorPrefix, failStartup, failUsage } from "../fail.ts";

export interface DeployInitOptions {
  force?: boolean;
  /** false ⇔ `--no-install` (forwarded to extension targets such as `agentcore`). */
  install?: boolean;
}

export interface DeployCheckOptions {
  json?: boolean;
}

const BUILTIN_TARGETS = ["docker", "compose", "fly", "railway"] as const;
type BuiltinTarget = (typeof BUILTIN_TARGETS)[number];
const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;

const COMPOSE_TARGET: ContainerTarget = {
  ...DOCKER_TARGET,
  writtenBy: "fastagent deploy init compose",
  ignore: ["compose.yml"],
};

const FLY_TARGET: ContainerTarget = {
  ...DOCKER_TARGET,
  writtenBy: "fastagent deploy init fly",
  ignore: ["fly.toml"],
};

const RAILWAY_TARGET: ContainerTarget = {
  ...DOCKER_TARGET,
  writtenBy: "fastagent deploy init railway",
};

function imageName(agentName: string): string {
  // Docker refuses an image reference with an uppercase letter or a leading separator; container and volume names do not.
  return agentName.toLowerCase().replace(/^[_-]+/, "") || "agent";
}

function flyAppName(agentName: string): string {
  return (
    agentName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 63)
      .replace(/-+$/, "") || "fastagent"
  );
}

function composeFile(port: number): string {
  return `services:
  agent:
    build: .
    restart: unless-stopped
    ports:
      - "${port}:${port}"
    env_file:
      - path: prod.env
        required: false
    volumes:
      - agent_data:${STORAGE_DIR}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

volumes:
  agent_data:
`;
}

function flyConfig(app: string, port: number): string {
  return `app = "${app}"

[[mounts]]
  source = "data"
  destination = "${STORAGE_DIR}"

[http_service]
  internal_port = ${port}
  force_https = true
  # Suspend to zero when idle and resume on demand; keep a single machine (--ha=false) so nothing else contends for ${STORAGE_DIR}.
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    timeout = "5s"
    path = "/health"
`;
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

async function runBuiltinInit(agentDir: string, target: BuiltinTarget, force: boolean): Promise<void> {
  const spec =
    target === "compose"
      ? COMPOSE_TARGET
      : target === "fly"
        ? FLY_TARGET
        : target === "railway"
          ? RAILWAY_TARGET
          : DOCKER_TARGET;
  const written = await writeContainer(agentDir, spec, { force }).catch(failStartup);
  if (!written.ok) failStartup(new Error(`deploy init ${target} stopped: ${written.gate}`));
  const { name, port } = written;

  if (target === "docker") {
    const image = imageName(name);
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

  if (target === "compose") {
    await writeOnce(agentDir, "compose.yml", composeFile(port));
    console.log(
      [
        "# Put the agent's values (its model key, FASTAGENT_API_KEY for the Agent API, declared secrets) in prod.env",
        "# (excluded from the image by .dockerignore), then start:",
        "docker compose up -d --build",
      ].join("\n"),
    );
    return;
  }

  if (target === "fly") {
    await writeOnce(agentDir, "fly.toml", flyConfig(flyAppName(name), port));
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

  // Railway deprecated railway.json/railway.toml (stops being read Dec 1, 2026) and mounts volumes outside config files.
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

export async function runDeployInit(target: string, opts: DeployInitOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  if ((BUILTIN_TARGETS as readonly string[]).includes(target)) {
    return runBuiltinInit(agentDir, target as BuiltinTarget, opts.force === true);
  }
  if (!EXTENSION_NAME.test(target)) {
    failUsage(
      `unknown deploy target "${target}" (built-in: ${BUILTIN_TARGETS.join(", ")}; or install @fastagent-sh/<target>)`,
    );
  }
  const entry = extensionEntry(agentDir, target);
  if (entry === undefined) {
    const pkg = extensionPackage(target);
    const version = await fastagentVersion();
    failUsage(
      `target "${target}" is provided by ${pkg}: install it in this agent (e.g. npm i ${pkg}@${version}), ` +
        `then run \`fastagent deploy init ${target}\``,
    );
  }
  const forwarded = [
    "init",
    ...(opts.force === true ? ["--force"] : []),
    ...(opts.install === false ? ["--no-install"] : []),
  ];
  await runExtension(entry, forwarded).catch(failStartup);
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
