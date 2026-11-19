/**
 * The fastagent command registry: every command as data ({@link CommandSpec}) with a lazy-imported implementation, so
 * `fastagent <cmd>` pays only for the module graph that command actually uses.
 */
import { fastagentVersion } from "../version.ts";
import { applyChdir } from "./chdir.ts";
import { buildProgram, type CommandSpec, type FlagSpec, type ProgramOptions } from "./kernel.ts";
import { unsupportedRuntime } from "../runtime.ts";
import { failStartup, failUsage } from "./fail.ts";
import { ENV_FILE_FLAG, INSTANCE_FLAGS, instanceFlags } from "./instance.ts";
import { extensionEntry, extensionPackage, runExtension } from "./extension.ts";

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
/** A served instance's Agent API, in place of the local one. */
const URL_FLAGS: FlagSpec[] = [
  { flags: "--url <base>", description: "a served instance's Agent API base URL" },
  { flags: "--key <key>", description: "API key for --url" },
];
const urlOptions = (f: Record<string, unknown>) => ({
  ...(typeof f.url === "string" ? { url: f.url } : {}),
  ...(typeof f.key === "string" ? { key: f.key } : {}),
});
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
    "Open the agent and serve its schedules, wake-ups and Agent API; restarts worker on src/ or config edits.",
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
  run: async (_args, f) =>
    (await import("./commands/dev.ts")).runDev(".", {
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
  description:
    "Inspect model, tools, extensions, schedules, commands and secrets read-only, from the directory: never the " +
    "instance's storage, so it answers beside a running serve.",
  flags: [JSON_FLAG, MODEL, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
  examples: [{ cmd: "fastagent info" }, { cmd: "fastagent info --json", note: "for CI" }],
  run: async (_args, f) =>
    (await import("./commands/info.ts")).runInfo(".", {
      json: f.json === true,
      model: f.model as string | undefined,
      instance: instanceFlags(f),
    }),
};

const build: CommandSpec = {
  name: "build",
  summary: "compile the agent into dist/, the package an app or a host opens",
  description: "Type-check and compile the agent into dist/ with a generated index.js entry.",
  flags: [{ flags: "--no-check", description: "emit without type-checking (tsc --noCheck)" }, JSON_FLAG],
  examples: [{ cmd: "fastagent build" }, { cmd: "fastagent build --json", note: "for CI" }],
  run: async (_args, f) =>
    (await import("./commands/build.ts")).runBuild(".", {
      check: f.check !== false,
      json: f.json === true,
    }),
};

const invoke: CommandSpec = {
  name: "invoke",
  summary: "send ONE message to the agent and exit",
  description:
    "Send one message and stream its answer to stdout: through the local serve of the instance when one runs, to a " +
    "served --url, or else in this process.",
  args: [{ name: "<message>", description: "the message to send" }],
  flags: [
    MODEL,
    NO_INPUT,
    { flags: "--json", description: "print receipt and message events as JSON lines" },
    { flags: "--session <id>", description: "continue an existing session" },
    ...URL_FLAGS,
    ...INSTANCE_FLAGS,
    ENV_FILE_FLAG,
  ],
  examples: [
    { cmd: `fastagent invoke "summarize today's inbox"` },
    { cmd: `fastagent invoke --session <id> "which number?"` },
    { cmd: `fastagent invoke --url https://agent.example.com "hello"`, note: "a deployment" },
  ],
  run: async (args, f) =>
    (await import("./commands/invoke.ts")).runInvoke(args[0] as string, ".", {
      model: f.model as string | undefined,
      input: f.input !== false,
      json: f.json === true,
      ...(typeof f.session === "string" ? { session: f.session } : {}),
      ...urlOptions(f),
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
  flags: [PORT, BIND, MODEL, NO_INPUT, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
  examples: [{ cmd: "fastagent start", note: "after fastagent build" }],
  run: async (_args, f) =>
    (await import("./commands/start.ts")).runStart(".", {
      port: f.port as string | undefined,
      bind: f.bind as string | undefined,
      model: f.model as string | undefined,
      input: f.input !== false,
      instance: instanceFlags(f),
    }),
};

const deploy: CommandSpec = {
  name: "deploy",
  summary: "prepare deployment files for a host (`init`), or verify the build context (`check`)",
  subcommands: [
    {
      name: "init",
      summary: "write container and platform files for a target (docker, compose, fly, railway, or an extension)",
      description:
        "Writes Dockerfile and .dockerignore plus the target's declarative config (never overwrites user-owned " +
        "files), and prints the platform's own deploy commands. Never runs a remote deploy or installs packages " +
        "into the agent.",
      args: [
        {
          name: "<target>",
          description:
            "docker, compose, fly, railway, or an installed @fastagent-sh/<target> extension (e.g. agentcore)",
        },
      ],
      flags: [
        { flags: "--force", description: "regenerate the container files fastagent generated" },
        {
          flags: "--no-install",
          description: "skip dependency installation in generated subprojects (e.g. agentcore/cdk)",
        },
      ],
      examples: [
        { cmd: "fastagent deploy init docker", note: "Dockerfile + .dockerignore for any host" },
        { cmd: "fastagent deploy init compose", note: "Dockerfile + compose.yml" },
        { cmd: "fastagent deploy init fly", note: "Dockerfile + fly.toml (single machine, /data, /health)" },
        { cmd: "fastagent deploy init railway", note: "Dockerfile + Railway volume and deploy commands" },
        { cmd: "fastagent deploy init agentcore", note: "AWS AgentCore (requires @fastagent-sh/agentcore)" },
      ],
      run: async (args, f) =>
        (await import("./commands/deploy.ts")).runDeployInit(args[0] as string, {
          force: f.force === true,
          install: f.install !== false,
        }),
    },
    {
      name: "check",
      summary: "verify the definition loads and the build context leaks no local secrets or state",
      description:
        "Read-only pre-deploy gate for CI (`fastagent deploy check && fly deploy`): exits 0 when safe, 1 on a fatal " +
        "gate or secret/state leak.",
      flags: [JSON_FLAG],
      examples: [{ cmd: "fastagent deploy check" }, { cmd: "fastagent deploy check --json", note: "for CI" }],
      run: async (_args, f) => (await import("./commands/deploy.ts")).runDeployCheck({ json: f.json === true }),
    },
  ],
};

const schedules: CommandSpec = {
  name: "schedules",
  summary: "list the schedules and wake-ups, run a schedule now, or cancel a wake-up",
  subcommands: [
    {
      name: "list",
      summary: "what fires next, how each schedule last ran, and the pending wake-ups, from the instance",
      flags: [JSON_FLAG, ...URL_FLAGS, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
      examples: [
        { cmd: "fastagent schedules list" },
        { cmd: "fastagent schedules list --url https://agent.example.com --json", note: "a deployment" },
      ],
      run: async (_args, f) =>
        (await import("./commands/schedules.ts")).runList(".", {
          json: f.json === true,
          ...urlOptions(f),
          instance: instanceFlags(f),
        }),
    },
    {
      name: "run",
      summary: "fire one schedule now, as its clock would, through the serve that owns the instance if one runs",
      args: [{ name: "<name>", description: "schedule name" }],
      flags: [MODEL, NO_INPUT, ...URL_FLAGS, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
      examples: [
        { cmd: "fastagent schedules run daily-digest" },
        { cmd: "fastagent schedules run daily-digest --url https://agent.example.com", note: "a deployment" },
      ],
      run: async (args, f) =>
        (await import("./commands/schedules.ts")).runScheduleNow(args[0] as string, ".", {
          model: f.model as string | undefined,
          input: f.input !== false,
          ...urlOptions(f),
          instance: instanceFlags(f),
        }),
    },
    {
      name: "unwake",
      summary: "cancel a pending wake-up, through the serve that owns the instance if one runs",
      args: [{ name: "<id>", description: "wake-up id (fastagent schedules list lists them)" }],
      flags: [...URL_FLAGS, ...INSTANCE_FLAGS, ENV_FILE_FLAG],
      examples: [{ cmd: "fastagent schedules unwake 3f1c…" }],
      run: async (args, f) =>
        (await import("./commands/schedules.ts")).runUnwake(args[0] as string, ".", {
          ...urlOptions(f),
          instance: instanceFlags(f),
        }),
    },
  ],
};

const login: CommandSpec = {
  name: "login",
  summary: "sign in to a model provider (account OAuth or API key), or check that one is ready",
  description:
    "Prompt interactively in a terminal, or return `need_choice`/`need_user_action` (exit 2) when non-interactive. " +
    "With --check, report whether the provider is ready instead: exit 0 ready, 1 not_ready, 2 invalid.",
  args: [{ name: "[provider]", description: "provider id or name; with --check a provider id or provider/modelId" }],
  flags: [
    GLOBAL_AUTH,
    { flags: "--check", description: "report readiness (ready, not_ready, invalid) without signing in" },
    { flags: "--method <how>", description: "account or api-key" },
    JSON_FLAG,
    { flags: "--timeout <seconds>", description: "interactive sign-in timeout" },
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent login" },
    { cmd: "fastagent login openai", note: "ChatGPT or API key" },
    { cmd: "fastagent login openai/gpt-5.5 --check --json", note: "is the model's provider ready?" },
  ],
  run: async (args, f) => {
    if (f.check === true) {
      if (f.method !== undefined || f.timeout !== undefined)
        failUsage("--check signs nothing in: drop --method and --timeout");
      return (await import("./commands/login-check.ts")).runLoginCheck(args[0] as string | undefined, {
        global: f.global === true,
        json: f.json === true,
      });
    }
    return (await import("./commands/login.ts")).runLogin(args[0] as string | undefined, {
      global: f.global === true,
      input: f.input !== false,
      json: f.json === true,
      ...(f.method !== undefined ? { method: f.method as string } : {}),
      ...(f.timeout !== undefined ? { timeout: f.timeout as string } : {}),
    });
  },
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

const specs: readonly CommandSpec[] = [init, login, logout, dev, invoke, info, models, schedules, build, start, deploy];

/** The production program assembly (specs + the top-level examples/docs). */
export function buildCliProgram(overrides: ProgramOptions = {}) {
  return buildProgram(specs, {
    examples: [
      { cmd: "fastagent init my-agent && cd my-agent", note: "scaffold an agent" },
      { cmd: "fastagent dev", note: "serve locally and iterate" },
      { cmd: "fastagent deploy init docker", note: "prepare a container for any host" },
    ],
    notes:
      "Platform extensions add targets to `fastagent deploy init <target>` and runtime commands once installed " +
      "(e.g. `npm i @fastagent-sh/agentcore`).\nDocs: https://github.com/fastagent-sh/fastagent",
    ...overrides,
  });
}

/** Parse and run one CLI invocation (`argv` = process.argv): a command of its own, or an installed extension's. */
export async function runCli(argv: readonly string[]): Promise<void> {
  const unsupported = unsupportedRuntime();
  if (unsupported !== undefined) failStartup(new Error(unsupported));
  const stripped = applyChdir(argv);
  const [name, ...rest] = stripped.slice(2);
  if (name !== undefined && !specs.some((spec) => spec.name === name)) {
    const entry = extensionEntry(process.cwd(), name);
    if (entry !== undefined) return runExtension(entry, rest).catch(failStartup);
  }
  await buildCliProgram({
    version: await fastagentVersion(),
    unknownCommandNote: (unknown) =>
      unknown === name && /^[a-z][a-z0-9-]*$/.test(unknown)
        ? `(an extension adds it: install ${extensionPackage(unknown)} in the agent, with npm i ${extensionPackage(unknown)})`
        : undefined,
  }).parseAsync(stripped);
}
