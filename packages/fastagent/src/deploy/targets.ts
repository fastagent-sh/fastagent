/**
 * Built-in deployment target specifications, naming helpers, and declarative config templates (`compose.yml`,
 * `fly.toml`) used by `fastagent deploy init <target>`.
 */
import { type ContainerTarget, DOCKER_TARGET, STORAGE_DIR } from "./container.ts";

export const BUILTIN_DEPLOY_TARGETS = ["docker", "compose", "fly", "railway"] as const;
export type BuiltinDeployTarget = (typeof BUILTIN_DEPLOY_TARGETS)[number];

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

export function targetContainerSpec(target: BuiltinDeployTarget): ContainerTarget {
  switch (target) {
    case "compose":
      return COMPOSE_TARGET;
    case "fly":
      return FLY_TARGET;
    case "railway":
      return RAILWAY_TARGET;
    case "docker":
      return DOCKER_TARGET;
  }
}

export function dockerImageName(agentName: string): string {
  // Docker refuses an image reference with an uppercase letter or a leading separator; container and volume names do not.
  return agentName.toLowerCase().replace(/^[_-]+/, "") || "agent";
}

export function flyAppName(agentName: string): string {
  return (
    agentName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 63)
      .replace(/-+$/, "") || "fastagent"
  );
}

export function composeFileContent(port: number): string {
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

export function flyConfigContent(app: string, port: number): string {
  return `app = "${app}"

[[mounts]]
  source = "data"
  destination = "${STORAGE_DIR}"

[http_service]
  internal_port = ${port}
  force_https = true
  # Suspend to zero when idle and resume on demand (keep requests open via stream/wait while turns run, or set
  # min_machines_running = 1 for fire-and-forget background turns); keep one machine (--ha=false) for ${STORAGE_DIR}.
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
