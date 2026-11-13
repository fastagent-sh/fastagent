/**
 * The fastagent command registry: every command as data ({@link CommandSpec}) with a lazy-imported implementation, so
 * `fastagent <cmd>` pays only for the module graph that command actually uses.
 */
import { fastagentVersion } from "../version.ts";
import { buildProgram, type CommandSpec, type FlagSpec, type ProgramOptions } from "./kernel.ts";
import { DEPLOY_HOSTS, type DeployHost } from "../deploy/hosts.ts";
import { unsupportedRuntime } from "../runtime.ts";
import { failStartup } from "./fail.ts";
import { CONFIG_FLAG, CONTENT_FLAGS, ENV_FILE_FLAG, INSTANCE_FLAGS, LAYER_FLAGS, instanceFlags } from "./instance.ts";

const AGENT_ARG = {
  name: "[agent]",
  description: "the agent directory holding fastagent.config.ts",
  default: ".",
};
const MODEL: FlagSpec = {
  flags: "--model <provider/modelId>",
  description: "model override (--model > FASTAGENT_MODEL > config)",
};
const JSON_FLAG: FlagSpec = { flags: "--json", description: "machine-readable JSON output" };
const NO_INPUT: FlagSpec = {
  flags: "--no-input",
  description: "never prompt — exit 2 when input is missing",
};
const PORT: FlagSpec = { flags: "--port <n>", description: "HTTP port" };
const BIND: FlagSpec = {
  flags: "--bind <addr>",
  description: "bind address (dev: 127.0.0.1; start: 0.0.0.0)",
};
const TUNNEL: FlagSpec = {
  flags: "--tunnel",
  description: "expose an ephemeral Cloudflare quick tunnel (needs cloudflared) and register webhooks",
};
const CHANNEL_ENVIRONMENT: FlagSpec = {
  flags: "--env <environment>",
  description: "credentials and state environment (dev or production)",
};
const GLOBAL_AUTH: FlagSpec = {
  flags: "-g, --global",
  description: "use global ~/.fastagent/.secrets/auth.json",
};
const DEPLOY_CONFIG: FlagSpec = {
  flags: "--config <file>",
  description: "instance config file (`deploy --config`)",
};
const DEPLOY_ENV_FILE: FlagSpec = {
  flags: "--env-file <file>",
  description: "host account env file (no default file for deployments)",
};

const init: CommandSpec = {
  name: "init",
  summary: "create an agent in a directory of its own and install its dependencies",
  description: "Scaffold SYSTEM.md, writing-great-skills, fastagent.config.ts, package.json, and .gitignore.",
  args: [{ name: "<dir>", description: "the new agent directory (created if missing)" }],
  flags: [
    {
      flags: "--content <source>",
      description: "directory or github:owner/repo the agent works on (repeatable)",
      repeatable: true,
    },
    { flags: "--no-install", description: "scaffold everything but skip npm install" },
  ],
  examples: [
    { cmd: "fastagent init my-agent", note: "an agent that only talks" },
    { cmd: "fastagent init reviewer --content ~/code/app", note: "works on ~/code/app" },
    { cmd: "fastagent init triage --content github:acme/app", note: "works on a clone" },
  ],
  run: async (args, f) =>
    (await import("./commands/init.ts")).runInit(args[0] as string, {
      install: f.install !== false,
      content: (f.content as string[] | undefined) ?? [],
    }),
};

const dev: CommandSpec = {
  name: "dev",
  summary: "serve the agent locally, restarting on code edits",
  description:
    "Open the agent and serve its channels, schedules, and wake-ups; restarts worker on src/ or config edits.",
  args: [AGENT_ARG],
  flags: [
    PORT,
    BIND,
    MODEL,
    { flags: "--no-watch", description: "serve once, no file-watching" },
    TUNNEL,
    NO_INPUT,
    ...INSTANCE_FLAGS,
    ...LAYER_FLAGS,
    CONFIG_FLAG,
    ENV_FILE_FLAG,
  ],
  examples: [{ cmd: "fastagent dev" }, { cmd: "fastagent dev --tunnel", note: "public URL + registered webhooks" }],
  run: async (args, f) =>
    (await import("./commands/dev.ts")).runDev(args[0] as string, {
      port: f.port as string | undefined,
      bind: f.bind as string | undefined,
      model: f.model as string | undefined,
      watch: f.watch !== false,
      tunnel: f.tunnel === true,
      input: f.input !== false,
      instance: instanceFlags(f),
    }),
};

const info: CommandSpec = {
  name: "info",
  summary: "print what the directory builds into, without serving",
  description: "Inspect model, tools, extensions, channels, schedules, commands, secrets, and content read-only.",
  args: [AGENT_ARG],
  flags: [JSON_FLAG, MODEL, ...INSTANCE_FLAGS, ...LAYER_FLAGS, CONFIG_FLAG, ENV_FILE_FLAG],
  examples: [{ cmd: "fastagent info" }, { cmd: "fastagent info --json", note: "for CI" }],
  run: async (args, f) =>
    (await import("./commands/info.ts")).runInfo(args[0] as string, {
      json: f.json === true,
      model: f.model as string | undefined,
      instance: instanceFlags(f),
    }),
};

const build: CommandSpec = {
  name: "build",
  summary: "compile the agent into dist/, the package an app or a host opens",
  description: "Type-check and compile the agent into dist/ with a generated index.js entry.",
  args: [AGENT_ARG],
  flags: [{ flags: "--no-check", description: "emit without type-checking (tsc --noCheck)" }, JSON_FLAG],
  examples: [{ cmd: "fastagent build" }, { cmd: "fastagent build --json", note: "for CI" }],
  run: async (args, f) =>
    (await import("./commands/build.ts")).runBuild(args[0] as string, {
      check: f.check !== false,
      json: f.json === true,
    }),
};

const invoke: CommandSpec = {
  name: "invoke",
  summary: "send ONE message to the agent and exit",
  description: "Send one message locally (or to a served --url) without starting a server; streams answer to stdout.",
  args: [{ name: "<message>", description: "the message to send" }, AGENT_ARG],
  flags: [
    MODEL,
    NO_INPUT,
    { flags: "--json", description: "print receipt and message events as JSON lines" },
    { flags: "--session <id>", description: "continue an existing session" },
    { flags: "--url <base>", description: "send to a served Agent API base URL" },
    { flags: "--key <key>", description: "API key for --url" },
    ...INSTANCE_FLAGS,
    ...LAYER_FLAGS,
    CONFIG_FLAG,
    ENV_FILE_FLAG,
  ],
  examples: [
    { cmd: `fastagent invoke "summarize today's inbox"` },
    { cmd: `fastagent invoke --session <id> "which number?"` },
    { cmd: `fastagent invoke --url https://a.fly.dev "hello"`, note: "a deployment" },
  ],
  run: async (args, f) =>
    (await import("./commands/invoke.ts")).runInvoke(args[0] as string, args[1] as string, {
      model: f.model as string | undefined,
      input: f.input !== false,
      json: f.json === true,
      ...(typeof f.session === "string" ? { session: f.session } : {}),
      ...(typeof f.url === "string" ? { url: f.url } : {}),
      ...(typeof f.key === "string" ? { key: f.key } : {}),
      instance: instanceFlags(f),
    }),
};

const models: CommandSpec = {
  name: "models",
  summary: 'list the available "provider/modelId" model specs',
  description: "List built-in and project-declared models; --refresh fetches updated provider catalogs.",
  args: [{ name: "[search]", description: "case-insensitive substring filter" }],
  flags: [
    { flags: "-g, --global", description: "built-ins only, without the agent's providers" },
    { flags: "--refresh", description: "fetch model lists now" },
    JSON_FLAG,
  ],
  examples: [
    { cmd: "fastagent models", note: "all specs" },
    { cmd: "fastagent models claude", note: "filter by provider or id" },
  ],
  run: async (args, f) =>
    (await import("./commands/models.ts")).runModels(args[0] as string | undefined, {
      global: f.global === true,
      refresh: f.refresh === true,
      json: f.json === true,
    }),
};

const start: CommandSpec = {
  name: "start",
  summary: "serve the built dist/ in production posture (no watching)",
  description: "Serve the compiled dist/ build; refuses a missing or stale build (`fastagent build`).",
  args: [AGENT_ARG],
  flags: [
    PORT,
    BIND,
    MODEL,
    TUNNEL,
    NO_INPUT,
    ...INSTANCE_FLAGS,
    ...LAYER_FLAGS,
    { ...CONFIG_FLAG, description: "instance configuration (FASTAGENT_CONFIG; ignores project fastagent.json)" },
    ENV_FILE_FLAG,
  ],
  examples: [
    { cmd: "fastagent start", note: "after fastagent build" },
    { cmd: "fastagent start --tunnel", note: "expose via quick tunnel" },
  ],
  run: async (args, f) =>
    (await import("./commands/start.ts")).runStart(args[0] as string, {
      port: f.port as string | undefined,
      bind: f.bind as string | undefined,
      model: f.model as string | undefined,
      tunnel: f.tunnel === true,
      input: f.input !== false,
      instance: instanceFlags(f),
    }),
};

const channelSub = (kind: "telegram" | "slack" | "feishu" | "lark", summary: string): CommandSpec => ({
  name: kind,
  summary,
  args: [AGENT_ARG],
  flags: [JSON_FLAG],
  examples: [{ cmd: `fastagent add ${kind}` }],
  run: async (args, f) =>
    (await import("./commands/add.ts")).runAddChannel(kind, args[0] as string, { json: f.json === true }),
});

const add: CommandSpec = {
  name: "add",
  summary: "connect a channel (telegram, slack, feishu, lark) or vendor a skill",
  description: "Scaffold src/channels/<kind>.ts and companion tools, or vendor a skill into skills/<name>/.",
  subcommands: [
    channelSub("telegram", "scaffold the Telegram bot channel and send tool"),
    channelSub("slack", "scaffold the Slack channel and send/threads tools"),
    channelSub("feishu", "scaffold the Feishu channel and send/threads tools"),
    channelSub("lark", "scaffold the Lark (international) channel and send/threads tools"),
    {
      name: "skill",
      summary: "vendor an Agent Skills skill into skills/<name>/",
      args: [{ name: "[source]", description: "owner/repo/path, local path, or global skill name" }, AGENT_ARG],
      flags: [{ flags: "--update", description: "overwrite an existing skill from source" }],
      examples: [
        { cmd: "fastagent add skill anthropics/skills/document-skills/pdf" },
        { cmd: "fastagent add skill ./my-skill --update" },
      ],
      run: async (args, f) =>
        (await import("./commands/add.ts")).runAddSkill(args[0] as string | undefined, args[1] as string, {
          update: f.update === true,
        }),
    },
  ],
};

const deploy: CommandSpec = {
  name: "deploy",
  summary: "generate deploy artifacts + runbook for docker, fly, railway, or agentcore (--run drives it)",
  description: "Generate Dockerfile/.dockerignore + host manifest and runbook, or provision & deploy with --run.",
  args: [{ name: "<host>", description: "deploy target", choices: [...DEPLOY_HOSTS] }, AGENT_ARG],
  flags: [
    { flags: "--run", description: "execute the deploy against the target CLI" },
    { flags: "--force", description: "overwrite existing generated artifacts" },
    { flags: "--config <file>", description: "instance configuration carried in the deployment" },
    { flags: "--env-file <file>", description: "env file of deployment values (no default file)" },
    { flags: "--from-env", description: "also read deployment values from this process's environment" },
    { flags: "--into-linked", description: "(railway --run) deploy into the already-linked Railway project" },
    { flags: "--idle-timeout <seconds>", description: "(agentcore) idle microVM timeout, 60–1209600s" },
    { flags: "--json", description: "with --run: print the deploy result as JSON" },
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent deploy fly --run", note: "provision + deploy + webhooks" },
    { cmd: "fastagent deploy docker --run", note: "Compose on this machine" },
    { cmd: "fastagent deploy railway", note: "print the runbook only" },
    { cmd: "fastagent deploy agentcore --run", note: "arm64 image + stack + webhooks" },
  ],
  run: async (args, f) =>
    (await import("./commands/deploy.ts")).runDeploy(args[0] as DeployHost, args[1] as string, {
      run: f.run === true,
      force: f.force === true,
      intoLinked: f.intoLinked === true,
      ...(typeof f.idleTimeout === "string" ? { idleTimeout: f.idleTimeout } : {}),
      ...(typeof f.config === "string" ? { config: f.config } : {}),
      ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
      fromEnv: f.fromEnv === true,
      input: f.input !== false,
      json: f.json === true,
    }),
};

const content: CommandSpec = {
  name: "content",
  summary: "list, add or remove what the agent works on",
  description: "Manage instance content entries in fastagent.json (program entries live in fastagent.config.ts).",
  subcommands: [
    {
      name: "list",
      summary: "each content entry and where it is",
      args: [AGENT_ARG],
      flags: [JSON_FLAG, ...CONTENT_FLAGS],
      examples: [{ cmd: "fastagent content list" }],
      run: async (args, f) =>
        (await import("./commands/content.ts")).runContentList(args[0] as string, f.json === true, instanceFlags(f)),
    },
    {
      name: "add",
      summary: "add a GitHub repository or a directory of this machine as content",
      args: [{ name: "<source>", description: "a directory, or github:owner/repo" }, AGENT_ARG],
      flags: [
        { flags: "--ref <ref>", description: "repository branch, tag, or commit" },
        { flags: "--name <name>", description: "entry name" },
        { flags: "--description <text>", description: "one-sentence description for the agent" },
        ...CONTENT_FLAGS,
      ],
      examples: [
        { cmd: "fastagent content add ~/code/app", note: "a directory" },
        { cmd: "fastagent content add github:acme/docs", note: "a clone" },
      ],
      run: async (args, f) =>
        (await import("./commands/content.ts")).runContentAdd(args[0] as string, args[1] as string, {
          ...(typeof f.ref === "string" ? { ref: f.ref } : {}),
          ...(typeof f.name === "string" ? { name: f.name } : {}),
          ...(typeof f.description === "string" ? { description: f.description } : {}),
          instance: instanceFlags(f),
        }),
    },
    {
      name: "remove",
      summary: "remove a content entry (leaves directories/clones on disk)",
      args: [{ name: "<name>", description: "the entry's name" }, AGENT_ARG],
      flags: [...CONTENT_FLAGS],
      examples: [{ cmd: "fastagent content remove app" }],
      run: async (args, f) =>
        (await import("./commands/content.ts")).runContentRemove(
          args[0] as string,
          args[1] as string,
          instanceFlags(f),
        ),
    },
  ],
};

const schedules: CommandSpec = {
  name: "schedules",
  summary: "list schedules and wake-ups, run a schedule now, or cancel a wake-up",
  subcommands: [
    {
      name: "list",
      summary: "list schedules (src/schedules/<name>.ts) and pending wake-ups",
      args: [AGENT_ARG],
      flags: [JSON_FLAG, ...INSTANCE_FLAGS],
      examples: [{ cmd: "fastagent schedules list" }],
      run: async (args, flags) =>
        (await import("./commands/schedules.ts")).runSchedulesList(
          args[0] as string,
          flags.json === true,
          instanceFlags(flags),
        ),
    },
    {
      name: "run",
      summary: "fire one schedule now, as its clock would",
      args: [{ name: "<name>", description: "schedule name" }, AGENT_ARG],
      flags: [MODEL, NO_INPUT, ...INSTANCE_FLAGS, ...LAYER_FLAGS, CONFIG_FLAG, ENV_FILE_FLAG],
      examples: [{ cmd: "fastagent schedules run daily-digest" }],
      run: async (args, f) =>
        (await import("./commands/schedules.ts")).runScheduleNow(args[0] as string, args[1] as string, {
          model: f.model as string | undefined,
          input: f.input !== false,
          instance: instanceFlags(f),
        }),
    },
    {
      name: "unwake",
      summary: "cancel a pending wake-up",
      args: [{ name: "<id>", description: "wake-up id" }, AGENT_ARG],
      flags: [...INSTANCE_FLAGS],
      examples: [{ cmd: "fastagent schedules unwake 3f1c…" }],
      run: async (args, f) =>
        (await import("./commands/schedules.ts")).runUnwake(args[0] as string, args[1] as string, instanceFlags(f)),
    },
  ],
};

const channels: CommandSpec = {
  name: "channels",
  summary: "a channel's platform app, for one instance",
  subcommands: [
    {
      name: "setup",
      summary: "set up a channel's platform app and store its credentials",
      description:
        "Guide setup in a terminal, validate values statelessly under --json/--no-input (exit 2 when missing), " +
        "or record a verified webhook URL with --record-url.",
      args: [{ name: "<name>", description: "telegram, slack, feishu, or lark" }, AGENT_ARG],
      flags: [
        { flags: "--ingress <mode>", description: "webhook or connection" },
        { flags: "--config <file>", description: "instance configuration (default: fastagent.json for dev)" },
        { flags: "--env-file <file>", description: "credentials file (required for deployments)" },
        { flags: "--from-env", description: "with --record-url: also read credentials from process env" },
        { flags: "--record-url", description: "record confirmed webhook URL into --config" },
        { flags: "--url <url>", description: "with --record-url: deployment base URL for /health" },
        JSON_FLAG,
        NO_INPUT,
      ],
      examples: [
        { cmd: "fastagent channels setup telegram" },
        { cmd: "fastagent channels setup slack --json", note: "validate or inspect missing steps" },
        { cmd: "fastagent channels setup slack --record-url --config c.json" },
      ],
      run: async (args, f) =>
        (await import("./commands/channels.ts")).runChannelsSetup(args[0] as string, args[1] as string, {
          recordUrl: f.recordUrl === true,
          ...(typeof f.ingress === "string" ? { ingress: f.ingress } : {}),
          ...(typeof f.config === "string" ? { config: f.config } : {}),
          ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
          fromEnv: f.fromEnv === true,
          ...(typeof f.url === "string" ? { url: f.url } : {}),
          json: f.json === true,
          input: f.input !== false,
        }),
    },
  ],
};

const SECRETS_HOST = {
  name: "<host>",
  description: "target host with a secret store",
  choices: ["fly", "railway", "agentcore"],
};

const secrets: CommandSpec = {
  name: "secrets",
  summary: "manage a deployment's secrets on its host",
  subcommands: [
    {
      name: "list",
      summary: "list declared secrets and whether each is set on the target",
      args: [SECRETS_HOST, AGENT_ARG],
      flags: [DEPLOY_CONFIG, JSON_FLAG],
      examples: [{ cmd: "fastagent secrets list fly" }],
      run: async (args, f) =>
        (await import("./commands/secrets.ts")).runSecrets("list", args[0] as "fly", undefined, args[1] as string, {
          ...(typeof f.config === "string" ? { config: f.config } : {}),
          json: f.json === true,
        }),
    },
    {
      name: "set",
      summary: "set one secret on the target (prompt, stdin, or --generate)",
      args: [SECRETS_HOST, { name: "<name>", description: "environment variable name" }, AGENT_ARG],
      flags: [DEPLOY_CONFIG, { flags: "--generate", description: "generate a random value and print once" }],
      examples: [
        { cmd: "fastagent secrets set fly OPENAI_API_KEY" },
        { cmd: "fastagent secrets set fly FASTAGENT_API_KEY --generate" },
      ],
      run: async (args, f) =>
        (await import("./commands/secrets.ts")).runSecrets(
          "set",
          args[0] as "fly",
          args[1] as string,
          args[2] as string,
          {
            ...(typeof f.config === "string" ? { config: f.config } : {}),
            generate: f.generate === true,
          },
        ),
    },
    {
      name: "push",
      summary: "push declared values from --env-file or --from-env",
      args: [SECRETS_HOST, AGENT_ARG],
      flags: [
        DEPLOY_CONFIG,
        { flags: "--env-file <file>", description: "env file to push" },
        { flags: "--from-env", description: "push from this process's environment" },
      ],
      examples: [
        { cmd: "fastagent secrets push fly --env-file prod.env" },
        { cmd: "doppler run -- fastagent secrets push fly --from-env" },
      ],
      run: async (args, f) =>
        (await import("./commands/secrets.ts")).runSecrets("push", args[0] as "fly", undefined, args[1] as string, {
          ...(typeof f.config === "string" ? { config: f.config } : {}),
          ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
          fromEnv: f.fromEnv === true,
        }),
    },
  ],
};

const destroy: CommandSpec = {
  name: "destroy",
  summary: "delete AWS resources `deploy agentcore` created",
  description: "Dry-run inventory by default; pass --run to delete stack, ECR repo, secret, logs, and schedules.",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, AGENT_ARG],
  flags: [DEPLOY_CONFIG, DEPLOY_ENV_FILE, { flags: "--run", description: "actually delete resources" }],
  examples: [
    { cmd: "fastagent destroy agentcore", note: "dry-run inventory" },
    { cmd: "fastagent destroy agentcore --run", note: "delete resources" },
  ],
  run: async (args, f) =>
    (await import("./commands/destroy.ts")).runDestroy(args[0] as string, args[1] as string, {
      run: f.run === true,
      ...(typeof f.config === "string" ? { config: f.config } : {}),
      ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
    }),
};

const logs: CommandSpec = {
  name: "logs",
  summary: "tail a deployed AgentCore host's CloudWatch logs",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, AGENT_ARG],
  flags: [
    DEPLOY_CONFIG,
    DEPLOY_ENV_FILE,
    { flags: "--source <source>", description: "runtime (default) or forwarder" },
    { flags: "--since <duration>", description: "history window (e.g. 30m or 2h)" },
    { flags: "--follow", description: "follow new log events" },
  ],
  examples: [
    { cmd: "fastagent logs agentcore --follow", note: "agent runtime" },
    { cmd: "fastagent logs agentcore --source forwarder --follow", note: "Lambda forwarder" },
  ],
  run: async (args, f) =>
    (await import("./commands/logs.ts")).runLogs(args[0] as string, args[1] as string, {
      ...(typeof f.config === "string" ? { config: f.config } : {}),
      ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
      source: f.source as string | undefined,
      since: f.since as string | undefined,
      follow: f.follow === true,
    }),
};

const login: CommandSpec = {
  name: "login",
  summary: "sign in to a model provider (account OAuth or API key)",
  description:
    "Prompt interactively in a terminal, or return `need_choice`/`need_user_action` (exit 2) when non-interactive.",
  args: [{ name: "[provider]", description: "provider id or name" }],
  flags: [
    GLOBAL_AUTH,
    { flags: "--method <how>", description: "account or api-key" },
    JSON_FLAG,
    { flags: "--timeout <seconds>", description: "interactive sign-in timeout" },
    { flags: "--deployment <host>", description: "run login on the deployed box (docker, fly, railway, agentcore)" },
    { flags: "--config <file>", description: "with --deployment: instance config" },
    { flags: "--env-file <file>", description: "with --deployment: host account env file" },
    { flags: "--stdio", description: "box-side relay mode", hidden: true },
    { flags: "--if-missing", description: "with --stdio: keep existing credential", hidden: true },
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent login" },
    { cmd: "fastagent login openai", note: "ChatGPT or API key" },
    { cmd: "fastagent login openai --deployment fly", note: "on deployed box" },
  ],
  run: async (args, f) =>
    (await import("./commands/login.ts")).runLogin(args[0] as string | undefined, {
      global: f.global === true,
      input: f.input !== false,
      json: f.json === true,
      ...(f.method !== undefined ? { method: f.method as string } : {}),
      ...(f.timeout !== undefined ? { timeout: f.timeout as string } : {}),
      ...(f.deployment !== undefined ? { deployment: f.deployment as string } : {}),
      ...(typeof f.config === "string" ? { config: f.config } : {}),
      ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
      stdio: f.stdio === true,
      ifMissing: f.ifMissing === true,
    }),
};

const logout: CommandSpec = {
  name: "logout",
  summary: "remove a provider's stored credential",
  args: [{ name: "[provider]", description: "provider id or name" }],
  flags: [GLOBAL_AUTH, NO_INPUT],
  examples: [{ cmd: "fastagent logout" }, { cmd: "fastagent logout openai-codex" }],
  run: async (args, f) =>
    (await import("./commands/logout.ts")).runLogout(args[0] as string | undefined, {
      global: f.global === true,
      input: f.input !== false,
    }),
};

const auth: CommandSpec = {
  name: "auth",
  summary: "check a model provider's credential",
  subcommands: [
    {
      name: "check",
      summary: "report whether a provider is ready (exit 0 ready, 1 not_ready, 2 invalid)",
      flags: [
        { flags: "--provider <id>", description: "provider id" },
        { flags: "--model <provider/modelId>", description: "resolve provider from model" },
        GLOBAL_AUTH,
        JSON_FLAG,
      ],
      examples: [
        { cmd: "fastagent auth check --provider openai" },
        { cmd: "fastagent auth check --model openai/gpt-5.5 --json" },
      ],
      run: async (_args, f) =>
        (await import("./commands/auth.ts")).runAuthCheck({
          ...(f.provider !== undefined ? { provider: f.provider as string } : {}),
          ...(f.model !== undefined ? { model: f.model as string } : {}),
          global: f.global === true,
          json: f.json === true,
        }),
    },
  ],
};

const mcp: CommandSpec = {
  name: "mcp",
  summary: "inspect MCP servers and manage explicit OAuth bindings",
  subcommands: [
    {
      name: "list",
      summary: "inspect declarations and local auth",
      examples: [{ cmd: "fastagent mcp list --json" }],
      args: [AGENT_ARG],
      flags: [CHANNEL_ENVIRONMENT, JSON_FLAG],
      run: async (args, f) =>
        (await import("./commands/mcp.ts")).runMcp("list", undefined, args[0] as string, {
          json: f.json === true,
          environment: f.env as string | undefined,
        }),
    },
    {
      name: "login",
      summary: "sign in to an MCP server via browser OAuth",
      examples: [{ cmd: "fastagent mcp login linear" }],
      args: [{ name: "[server]", description: "declared MCP server name" }, AGENT_ARG],
      flags: [
        CHANNEL_ENVIRONMENT,
        JSON_FLAG,
        NO_INPUT,
        { flags: "--timeout <seconds>", description: "browser OAuth timeout (default 900)" },
        { flags: "--scopes <scopes>", description: "comma-separated OAuth scopes" },
        { flags: "--client-id <id>", description: "pre-registered client ID or metadata URL" },
        { flags: "--callback-port <port>", description: "local callback port" },
      ],
      run: async (args, f) =>
        (await import("./commands/mcp.ts")).runMcp("login", args[0] as string | undefined, args[1] as string, {
          json: f.json === true,
          input: f.input !== false,
          environment: f.env as string | undefined,
          scopes: f.scopes as string | undefined,
          clientId: f.clientId as string | undefined,
          callbackPort: f.callbackPort as string | undefined,
          timeout: f.timeout as string | undefined,
        }),
    },
    {
      name: "disconnect",
      summary: "remove a local OAuth binding",
      examples: [{ cmd: "fastagent mcp disconnect linear" }],
      args: [{ name: "<server>", description: "the server name" }, AGENT_ARG],
      flags: [CHANNEL_ENVIRONMENT, JSON_FLAG],
      run: async (args, f) =>
        (await import("./commands/mcp.ts")).runMcp("disconnect", args[0] as string, args[1] as string, {
          json: f.json === true,
          environment: f.env as string | undefined,
        }),
    },
  ],
};

const specs: readonly CommandSpec[] = [
  init,
  models,
  mcp,
  info,
  build,
  content,
  invoke,
  schedules,
  dev,
  start,
  add,
  channels,
  secrets,
  deploy,
  logs,
  destroy,
  login,
  logout,
  auth,
];

/** The production program assembly (specs + the top-level examples/docs). */
export function buildCliProgram(overrides: ProgramOptions = {}) {
  return buildProgram(specs, {
    examples: [
      { cmd: "fastagent init my-agent && cd my-agent", note: "scaffold an agent" },
      { cmd: "fastagent dev", note: "serve locally and iterate" },
      { cmd: "fastagent deploy fly --run", note: "ship it" },
    ],
    notes: "Docs: https://github.com/fastagent-sh/fastagent",
    ...overrides,
  });
}

/** Parse and run one CLI invocation (`argv` = process.argv). */
export async function runCli(argv: readonly string[]): Promise<void> {
  const unsupported = unsupportedRuntime();
  if (unsupported !== undefined) failStartup(new Error(unsupported));
  await buildCliProgram({ version: await fastagentVersion() }).parseAsync([...argv]);
}
