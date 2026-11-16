/**
 * The fastagent command registry: every command as data ({@link CommandSpec}) with a lazy-imported implementation, so
 * `fastagent <cmd>` pays only for the module graph that command actually uses.
 */
import { fastagentVersion } from "../version.ts";
import { buildProgram, type CommandSpec, type FlagSpec, type ProgramOptions } from "./kernel.ts";
import { unsupportedRuntime } from "../runtime.ts";
import { failStartup } from "./fail.ts";
import { ENV_FILE_FLAG, INSTANCE_FLAGS, instanceFlags } from "./instance.ts";

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
const GLOBAL_AUTH: FlagSpec = {
  flags: "-g, --global",
  description: "use global ~/.fastagent/.secrets/auth.json",
};

const init: CommandSpec = {
  name: "init",
  summary: "create an agent in a directory of its own and install its dependencies",
  description: "Scaffold SYSTEM.md, writing-great-skills, fastagent.config.ts, package.json, and .gitignore.",
  args: [{ name: "<dir>", description: "the new agent directory (created if missing)" }],
  flags: [{ flags: "--no-install", description: "scaffold everything but skip npm install" }],
  examples: [{ cmd: "fastagent init my-agent" }],
  run: async (args, f) =>
    (await import("./commands/init.ts")).runInit(args[0] as string, { install: f.install !== false }),
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
    NO_INPUT,
    ...INSTANCE_FLAGS,
    ENV_FILE_FLAG,
  ],
  examples: [{ cmd: "fastagent dev" }],
  run: async (args, f) =>
    (await import("./commands/dev.ts")).runDev(args[0] as string, {
      port: f.port as string | undefined,
      bind: f.bind as string | undefined,
      model: f.model as string | undefined,
      watch: f.watch !== false,
      input: f.input !== false,
      instance: instanceFlags(f),
    }),
};

const info: CommandSpec = {
  name: "info",
  summary: "print what the directory builds into, without serving",
  description: "Inspect model, tools, extensions, channels, schedules, commands and secrets read-only.",
  args: [AGENT_ARG],
  flags: [JSON_FLAG, MODEL, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
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
  flags: [PORT, BIND, MODEL, NO_INPUT, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
  examples: [{ cmd: "fastagent start", note: "after fastagent build" }],
  run: async (args, f) =>
    (await import("./commands/start.ts")).runStart(args[0] as string, {
      port: f.port as string | undefined,
      bind: f.bind as string | undefined,
      model: f.model as string | undefined,
      input: f.input !== false,
      instance: instanceFlags(f),
    }),
};

const deploy: CommandSpec = {
  name: "deploy",
  summary: "write the portable container (Dockerfile, .dockerignore) and print how to run it",
  description: "Writes the Dockerfile and .dockerignore into the agent directory; a file you own is kept.",
  args: [{ name: "<target>", description: "what to deploy as", choices: ["docker"] }, AGENT_ARG],
  flags: [{ flags: "--force", description: "regenerate the files fastagent generated" }],
  examples: [{ cmd: "fastagent deploy docker", note: "Dockerfile + .dockerignore, and the docker commands" }],
  run: async (args, f) =>
    (await import("./commands/deploy.ts")).runDeploy(args[1] as string, { force: f.force === true }),
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
      flags: [MODEL, NO_INPUT, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
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
        "Guide setup in a terminal, or validate values statelessly under --json/--no-input (exit 2 when missing).",
      args: [{ name: "<platform>", description: "telegram, slack, feishu, or lark" }, AGENT_ARG],
      flags: [
        {
          flags: "--env-file <file>",
          description: "keep a deployment's credentials in this file (default: the development .secrets/.env)",
        },
        JSON_FLAG,
        NO_INPUT,
      ],
      examples: [
        { cmd: "fastagent channels setup telegram" },
        { cmd: "fastagent channels setup slack --json", note: "validate or inspect missing steps" },
        { cmd: "fastagent channels setup feishu --env-file prod.env", note: "a separate app for a deployment" },
      ],
      run: async (args, f) =>
        (await import("./commands/channels.ts")).runChannelsSetup(args[0] as string, args[1] as string, {
          ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
          json: f.json === true,
          input: f.input !== false,
        }),
    },
  ],
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
    NO_INPUT,
  ],
  examples: [{ cmd: "fastagent login" }, { cmd: "fastagent login openai", note: "ChatGPT or API key" }],
  run: async (args, f) =>
    (await import("./commands/login.ts")).runLogin(args[0] as string | undefined, {
      global: f.global === true,
      input: f.input !== false,
      json: f.json === true,
      ...(f.method !== undefined ? { method: f.method as string } : {}),
      ...(f.timeout !== undefined ? { timeout: f.timeout as string } : {}),
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

const specs: readonly CommandSpec[] = [
  init,
  models,
  info,
  build,
  invoke,
  schedules,
  dev,
  start,
  channels,
  deploy,
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
      { cmd: "fastagent deploy docker", note: "a container for any host" },
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
