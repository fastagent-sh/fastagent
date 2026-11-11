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

// Help groups (clig: most common commands first) — the authoring loop leads, operations close.
const AGENT_ARG = {
  name: "[agent]",
  description: "the agent directory, the one holding fastagent.config.ts",
  default: ".",
};
const MODEL: FlagSpec = {
  flags: "--model <provider/modelId>",
  description: "model override (precedence: --model > FASTAGENT_MODEL > config)",
};
const JSON_FLAG: FlagSpec = { flags: "--json", description: "machine-readable JSON output" };
const NO_INPUT: FlagSpec = {
  flags: "--no-input",
  description: "never prompt (CI/scripts) — missing information becomes an error instead of a question",
};
const PORT: FlagSpec = { flags: "--port <n>", description: "HTTP port" };
const BIND: FlagSpec = {
  flags: "--bind <addr>",
  description: "bind address (dev defaults to 127.0.0.1; start defaults to all interfaces, which containers need)",
};
const TUNNEL: FlagSpec = {
  flags: "--tunnel",
  description:
    "expose a public HTTPS URL via a Cloudflare quick tunnel (needs cloudflared) and auto-register " +
    "webhook channels (telegram, onboarded slack, feishu, lark; manual slack prints the URL) — for hosting a bot from your " +
    "own box without deploying (the quick-tunnel URL is ephemeral, not for production)",
};

const init: CommandSpec = {
  name: "init",
  summary: "create an agent in a directory of its own and install its dependencies",
  description:
    "Create an agent in dir, which must be new or empty, then run npm install there. Content is a " +
    "self-iterating agent: SYSTEM.md (its system prompt), a writing-great-skills " +
    "example skill, config, package.json, .gitignore.",
  args: [{ name: "<dir>", description: "the new agent's directory (created when missing)" }],
  flags: [
    {
      flags: "--content <source>",
      description:
        "a directory or github:owner/repo the agent works on (repeatable): a repository in context.json, a " +
        "directory of this machine in fastagent.json",
      repeatable: true,
    },
    { flags: "--no-install", description: "scaffold everything but skip npm install" },
  ],
  examples: [
    { cmd: "fastagent init my-agent", note: "an agent that only talks" },
    { cmd: "fastagent init reviewer --content ~/code/app", note: "works on ~/code/app" },
    { cmd: "fastagent init triage --content github:acme/app", note: "works on a clone" },
  ],
  notes:
    "An agent is a directory holding a fastagent.config.ts, and it is also the agent's working directory. " +
    "It lives in a directory of its own, beside what it works on and never inside another agent: what it works on is declared " +
    "as its content. Add a directory later with `fastagent content add <dir>`.",
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
    "Open the agent (default .) and serve its channels, schedules and wake-ups. SYSTEM.md, AGENTS.md, " +
    "skills/ and prompts/ are re-read for every message (edits go live with the next one); edits to code inputs " +
    "(src/, fastagent.config.ts, package.json, .secrets/.env) restart the worker once its running messages finish. " +
    "Files the agent writes as work product never trigger a restart.",
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
  examples: [
    { cmd: "fastagent dev" },
    { cmd: "fastagent dev --tunnel", note: "public URL + registered/guided webhooks" },
  ],
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
  description:
    "Print what the agent (default .) builds into — model, tools, extensions, channels, schedules, commands, " +
    "secrets, content — WITHOUT opening or serving it. An unset model or secret is reported, not fatal. " +
    "Run it first when something looks off.",
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
  description:
    "Compile the agent (default .) into dist/: its code with the project's TypeScript (type-checked, per file), its " +
    "text, skills, prompts, assets and the resources beside its code, and a generated entry (index.js) whose default " +
    "export is the definition. It refuses what dev refuses, and a type error. dist/ is replaced whole; it holds no " +
    "secret, state or clone.",
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
  description:
    "Send ONE message to the agent and exit — no server. The answer streams to stdout, tool/diagnostics to " +
    "stderr; --json prints the receipt and the message's events as JSON lines instead. A message that does not " +
    "complete exits non-zero. Each run starts a new session and prints its id on stderr; --session <id> sends " +
    "the message into that session instead, continuing it. Sessions are kept in <state>/invoke.sqlite, apart " +
    "from the storage a serve holds, so it runs beside `dev`; one invoke of an agent runs at a time. Same model " +
    "resolution as dev, a continued session included. --url <base> sends it to a served agent instead, over its " +
    "Agent API, with the same output and exit code: a deployment checked as the agent was before it, with the " +
    "key --key gives or the first FASTAGENT_API_KEY in .secrets/production/.env, which deploy writes. For CI " +
    "smoke and quick checks, by a person or a coding agent.",
  args: [{ name: "<message>", description: "the message to send" }, AGENT_ARG],
  flags: [
    MODEL,
    NO_INPUT,
    { flags: "--json", description: "the receipt and the message's events as JSON lines on stdout" },
    { flags: "--session <id>", description: "continue the session an earlier invoke printed" },
    { flags: "--url <base>", description: "send to the agent served at <base>, over its Agent API" },
    { flags: "--key <key>", description: "the API key for --url (default: the agent's production one)" },
    ...INSTANCE_FLAGS,
    ...LAYER_FLAGS,
    CONFIG_FLAG,
    ENV_FILE_FLAG,
  ],
  examples: [
    { cmd: `fastagent invoke "summarize today's inbox"` },
    { cmd: `fastagent invoke "remember 42"`, note: "prints its session's id" },
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
  description:
    'List every "provider/modelId" spec the agent in this directory can name (pi-ai\'s built-ins, with the models ' +
    "pi's published catalog adds to them, and the providers its fastagent.config.ts declares) — use one with " +
    "--model or as `defaults.model` in fastagent.config.ts. Outside an agent, or with -g, list the built-ins without the " +
    "agent's providers. Every command that opens the agent refreshes the lists, asking at most every 4 hours once " +
    "one is kept; --refresh asks now, and exits 1 when it cannot.",
  args: [{ name: "[search]", description: "case-insensitive substring filter" }],
  flags: [
    { flags: "-g, --global", description: "the built-ins, without the agent's providers" },
    { flags: "--refresh", description: "fetch the model lists now, even when the kept ones are fresh" },
    { flags: "--json", description: "the specs as JSON: spec, provider, id and name of each (its id, unnamed)" },
  ],
  examples: [
    { cmd: "fastagent models", note: "all specs" },
    { cmd: "fastagent models claude", note: "filter; provider-name matches rank first" },
    { cmd: "fastagent models --refresh gpt", note: "a model released since the last refresh" },
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
  description:
    "Serve the agent's dist/ (default .) in production posture, just no file-watching; refuses a " +
    "missing or stale dist/, naming `fastagent build`. model and http.port come from " +
    "defaults in fastagent.config.ts, over which --config's fastagent.json sets the instance's own.",
  args: [AGENT_ARG],
  flags: [
    PORT,
    BIND,
    MODEL,
    TUNNEL,
    NO_INPUT,
    ...INSTANCE_FLAGS,
    ...LAYER_FLAGS,
    {
      ...CONFIG_FLAG,
      description: "the instance configuration, a fastagent.json (FASTAGENT_CONFIG); start never reads the project's",
    },
    ENV_FILE_FLAG,
  ],
  examples: [
    { cmd: "fastagent start", note: "after fastagent build" },
    { cmd: "fastagent start --tunnel", note: "host a bot from your own box, no deploy" },
  ],
  notes:
    "Precedence chains:\n" +
    "  port:     --port > PORT env > fastagent.config.ts http.port > 8787\n" +
    "  bind:     --bind > all interfaces (dev: 127.0.0.1)\n" +
    "  state:    --state > FASTAGENT_STATE_DIR > <root>/.state >\n" +
    "            <agent dir>/.state/production\n" +
    "            the agent's storage (agent.sqlite), channels, schedules; use a\n" +
    "            mounted volume so a redeploy never wipes it\n" +
    "  workdir:  --workdir > FASTAGENT_WORKDIR > --root > <agent dir>\n" +
    "  config:   --config > FASTAGENT_CONFIG > FASTAGENT_CONFIG_JSON (its JSON)\n" +
    "            > none (never fastagent.json)\n" +
    "  secrets:  --env-file > FASTAGENT_SECRETS_DIR > <agent dir>/.secrets/production\n" +
    "            .env + auth.json\n" +
    "  content:  <workdir>/content/<name> — a clone of github content; a\n" +
    "            deployment links content/ to its volume\n" +
    "  auth:     FASTAGENT_AUTH_PATH > <secrets>/auth.json\n" +
    "            (project-level; point it at ~/.fastagent/.secrets/auth.json to\n" +
    "            share one credential across projects)",
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

const CHANNEL_ENVIRONMENT: FlagSpec = {
  flags: "--env <environment>",
  description: "select independent credentials and state (default: dev; production uses .secrets/production/.env)",
};

const channelSub = (
  kind: "telegram" | "slack" | "feishu" | "lark",
  summary: string,
  description: string,
  notes?: string,
): CommandSpec => ({
  name: kind,
  summary,
  description,
  args: [AGENT_ARG],
  flags: [JSON_FLAG],
  examples: [{ cmd: `fastagent add ${kind}` }],
  ...(notes ? { notes } : {}),
  run: async (args, f) =>
    (await import("./commands/add.ts")).runAddChannel(kind, args[0] as string, { json: f.json === true }),
});

const add: CommandSpec = {
  name: "add",
  summary: "connect a channel (telegram, slack, feishu, lark) or vendor a skill",
  description:
    "Scaffold channels/<kind>.ts — first-party adapter glue with the policy to edit in the optional " +
    "route() — or vendor an Agent Skills skill into skills/<name>/.",
  subcommands: [
    channelSub(
      "telegram",
      "scaffold the Telegram bot channel (long polling or webhook, durable turns, live preview)",
      "Scaffold src/channels/telegram.ts — the Telegram bot channel with durable turns, a live-preview " +
        "message pump, and an optional route() policy — and its send tool. Changes the program only: " +
        "`fastagent channels setup telegram` sets up the bot and keeps its token.",
    ),
    channelSub(
      "slack",
      "scaffold the Slack channel (Socket Mode or Events API, files, threads, context, live preview)",
      "Scaffold src/channels/slack.ts plus its tools (src/tools/slack-send.ts, slack-threads.ts): durable turns, " +
        "files, threads, context, and an edited live preview, received over Socket Mode or the Events API. Changes " +
        "the program only: `fastagent channels setup slack` creates the app from a manifest link and keeps its tokens.",
    ),
    channelSub(
      "feishu",
      "scaffold the Feishu channel (long connection or webhook, durable turns, streaming card)",
      "Scaffold src/channels/feishu.ts plus its tools (src/tools/feishu-send.ts, feishu-threads.ts). Changes the " +
        "program only: `fastagent channels setup feishu` creates the app by scan-to-create and keeps its credentials.",
      "Feishu (open.feishu.cn) is the canonical implementation. A long connection needs only App ID/Secret and " +
        "no public URL; a webhook additionally needs the Verification Token, which setup captures through a " +
        "temporary tunnel. The app asks for the scopes that let the agent hear its group chats; any your tenant " +
        "withholds are named.",
    ),
    channelSub(
      "lark",
      "scaffold the Lark (international) channel",
      "Scaffold src/channels/lark.ts plus its tools (src/tools/lark-send.ts, lark-threads.ts). Changes the program " +
        "only: `fastagent channels setup lark` guides the app's creation on Lark's launcher, checks the App ID " +
        "and Secret, and keeps them.",
      "Lark international (open.larksuite.com) is Feishu's compatibility profile. A long connection stops after " +
        "App ID/Secret validation and a permission check; a webhook tries to capture the Verification Token " +
        "and asks for it when the international config API answers 404.",
    ),
    {
      name: "skill",
      summary: "vendor an Agent Skills skill into skills/<name>/ (copied in, git-tracked)",
      args: [
        {
          name: "[source]",
          description:
            "a git ref (owner/repo/path, github default), a local path (./x, /abs), or a bare name " +
            "from your global skill dirs (~/.agents/skills, ~/.pi/agent/skills)",
        },
        AGENT_ARG,
      ],
      flags: [
        { flags: "--update", description: "overwrite an existing skill (re-fetch from source); review with git diff" },
      ],
      examples: [
        { cmd: "fastagent add skill anthropics/skills/document-skills/pdf" },
        { cmd: "fastagent add skill ./my-skill --update" },
      ],
      notes:
        "Writing your own skill needs no command: create skills/<name>/SKILL.md with name + " +
        "description frontmatter; it's auto-discovered. `add skill` is only for vendoring an " +
        "existing one.",
      run: async (args, f) =>
        (await import("./commands/add.ts")).runAddSkill(args[0] as string | undefined, args[1] as string, {
          update: f.update === true,
        }),
    },
  ],
};

const deploy: CommandSpec = {
  name: "deploy",
  summary: "generate deploy artifacts + a runbook for docker, fly, railway, or agentcore (--run drives it)",
  description:
    "Generate Dockerfile/.dockerignore plus the target config and print an ordered runbook. " +
    "docker: fastagent.<name>.compose.yml, loopback port, persistent state volume. fly: fly.<name>.toml " +
    "(autostop=suspend, state→volume). railway: no config file; its volume/variables/App-Sleeping " +
    "are dashboard/CLI steps the runbook states. agentcore: one " +
    "CloudFormation stack (AWS Bedrock AgentCore Runtime + forwarder Lambda for webhooks + " +
    "the alarms the container sets for schedules and wake-ups; linux/arm64 image built locally). Durable ingress " +
    "remains operator-owned (agentcore's forwarder URL is the exception — the stack owns it). " +
    "Production values come from .secrets/production/.env, never the dev file. Interactive --run creates " +
    "a separate Feishu/Lark production app when its credentials are missing.",
  args: [{ name: "<host>", description: "deploy target", choices: [...DEPLOY_HOSTS] }, AGENT_ARG],
  flags: [
    {
      flags: "--run",
      description:
        "drive the target CLI to completion. Docker builds (pulling the base image) and runs `docker compose up -d`. Fly/Railway provision app/service + volume + " +
        "secrets + deploy + webhook setup. AgentCore builds/pushes the arm64 image and deploys the " +
        "stack (aws + docker CLIs). A model key is a value of the target (fastagent secrets); any other credential is a login on " +
        "the deployment itself, which --run starts once the box is up (fastagent login --deployment). " +
        "Stops at a gate (missing CLI/daemon/login/secret) with one actionable line. Without it: prints " +
        "the runbook",
    },
    { flags: "--force", description: "overwrite existing target config/Dockerfile/.dockerignore (else kept)" },
    {
      flags: "--config <file>",
      description:
        "the instance configuration (a fastagent.json) the deployment runs with, carried in the image; its `name` " +
        "names the deployment (default: the program's name). Without it, the program's defaults (the project's " +
        "fastagent.json is the development instance's)",
    },
    {
      flags: "--into-linked",
      description:
        "(railway --run) provision INTO the project this dir is linked to even when it is not the agent's " +
        "(it holds no service of this name and is not named for it); by default --run refuses that link " +
        "(could be unrelated/production)",
    },
    {
      flags: "--idle-timeout <seconds>",
      description:
        "(agentcore) how long an idle session keeps its microVM, 60 to 1209600 (default: defaults.deploy.agentcore." +
        "idleTimeoutSeconds in fastagent.config.ts, else 180)",
    },
    {
      flags: "--json",
      description:
        "with --run, for a coding agent: the deploy runs in a process of its own and the command returns its " +
        "ticket, handing each step only a person can take (a host sign-in, a production app, the box's model " +
        "login) to its user",
    },
    { flags: "--check <ticket>", description: "where a deploy started with --json stands" },
    {
      flags: "--code <code>",
      description: "with --check: the code a host's approval page showed, when it could not reach this machine",
    },
    { flags: "--timeout <seconds>", description: "how long a deploy started with --json stays open (default 3600)" },
    { flags: "--stop", description: "with --check: stop that deploy where it is (can leave the host half-changed)" },
    { flags: "--ticket <id>", description: "the process that runs a ticket's deploy", hidden: true },
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent deploy fly --run", note: "provision + deploy + webhooks" },
    { cmd: "fastagent deploy fly --run --json", note: "a coding agent" },
    { cmd: "fastagent deploy docker --run", note: "Compose on this machine" },
    { cmd: "fastagent deploy railway", note: "print the runbook only" },
    { cmd: "fastagent deploy agentcore --run", note: "arm64 image + stack + webhooks" },
  ],
  notes:
    "Definition-read-only: the only writes are generated artifacts (never clobbered without --force). A plain " +
    "redeploy of an already-provisioned agent is just the host's own command (e.g. `railway up`).",
  run: async (args, f) =>
    (await import("./commands/deploy.ts")).runDeploy(args[0] as DeployHost, args[1] as string, {
      run: f.run === true,
      force: f.force === true,
      intoLinked: f.intoLinked === true,
      ...(typeof f.idleTimeout === "string" ? { idleTimeout: f.idleTimeout } : {}),
      ...(typeof f.config === "string" ? { config: f.config } : {}),
      input: f.input !== false,
      json: f.json === true,
      ...(f.check !== undefined ? { check: f.check as string } : {}),
      ...(f.code !== undefined ? { code: f.code as string } : {}),
      ...(f.timeout !== undefined ? { timeout: f.timeout as string } : {}),
      ...(f.ticket !== undefined ? { ticket: f.ticket as string } : {}),
      stop: f.stop === true,
    }),
};

const env: CommandSpec = {
  name: "env",
  summary: "add, remove or list the commands the agent runs: its environment",
  description:
    "The agent's environment is the `environment` of its context.json: `packages`, each a name from mise's registry " +
    "or written with aqua:, github:, gitlab:, conda:, npm: or pypi:, with a version; `aptPackages`, Debian " +
    "packages the image installs; and `variables`, the environment variables its commands read, each declared by " +
    "name with a description (its value goes in .secrets/.env, never in context.json; every one is required). " +
    "Variables are edited in context.json by hand. Nothing is locked: each place installs the newest release a " +
    "version allows when it first needs a package, and the image installs every package when it is built. Run in " +
    "the agent directory (the current one). The first change adds mise to the agent's package.json (one optional " +
    "package per platform; npm installs this machine's), so nothing has to be installed first.",
  subcommands: [
    {
      name: "add",
      summary: "add packages: installed here first, then declared",
      args: [{ name: "<packages...>", description: "name[@version] (default latest), or apt:<name> for the image" }],
      examples: [
        { cmd: "fastagent env add gh@2", note: "a CLI from mise's registry" },
        { cmd: "fastagent env add npm:prettier@3", note: "an npm package" },
        { cmd: "fastagent env add python uv pypi:markitdown", note: "PyPI, with its runtime" },
        { cmd: "fastagent env add apt:chromium", note: "installed by the image" },
      ],
      run: async (args) => (await import("./commands/env.ts")).runEnvAdd(args[0] as string[]),
    },
    {
      name: "remove",
      summary: "remove packages, by the name they are declared with",
      args: [{ name: "<packages...>", description: "a declared package, or apt:<name>" }],
      examples: [{ cmd: "fastagent env remove gh apt:chromium" }],
      run: async (args) => (await import("./commands/env.ts")).runEnvRemove(args[0] as string[]),
    },
    {
      name: "list",
      summary: "the declared packages and their versions, the variables and whether each has a value",
      flags: [{ flags: "--json", description: "the packages, apt packages and variables as JSON" }],
      examples: [{ cmd: "fastagent env list" }, { cmd: "fastagent env list --json" }],
      run: async (_args, f) => (await import("./commands/env.ts")).runEnvList({ json: f.json === true }),
    },
    {
      name: "install",
      summary: "install what context.json declares here, at the newest release each version allows",
      description:
        "Install the agent's mise (adding it to package.json when it is not there), then every package context.json " +
        "declares, at the newest release its version allows: a newer one where one is out. Not needed day to day " +
        "(`add` installs what it adds, and every start installs what is missing): it is for a newer release, and " +
        "for a clone that has not installed its mise yet.",
      examples: [{ cmd: "fastagent env install", note: "after a clone, or for newer releases" }],
      run: async () => (await import("./commands/env.ts")).runEnvInstall(),
    },
    {
      name: "exec",
      summary: "run a command in the environment, with the agent's .secrets/.env",
      args: [{ name: "<command...>", description: "the command and its arguments, after --", verbatim: true }],
      examples: [{ cmd: "fastagent env exec -- gh --version" }],
      run: async (args) => (await import("./commands/env.ts")).runEnvExec(args[0] as string[]),
    },
  ],
  notes:
    "`dev`, `start` and `invoke` install the declared packages that have no install here yet, and " +
    "put them first on the PATH of what the agent runs; one already installed is kept, so a start needs no network. " +
    "`dev` restarts when context.json changes. Apt packages are installed in the image; on Debian or Ubuntu a start " +
    "here names the missing ones.",
};

const content: CommandSpec = {
  name: "content",
  summary: "list, add or remove what the agent works on",
  description:
    "Content is a directory the agent works on: a GitHub repository, cloned at content/<name> in the instance's " +
    "working directory, or a directory of this machine. The program's context.json declares repositories every " +
    "instance reaches; an instance's fastagent.json adds its own, repositories and directories, and only adds: a " +
    "name the program declares is not one it may take.",
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
        { flags: "--ref <ref>", description: "a repository: the branch, tag or commit to clone" },
        { flags: "--name <name>", description: "its name (default: the directory's or repository's)" },
        { flags: "--description <text>", description: "one sentence for the agent: what it is, how to treat it" },
        {
          flags: "--program",
          description: "declare a repository in context.json, for every instance of the program, not in fastagent.json",
        },
        ...CONTENT_FLAGS,
      ],
      examples: [
        { cmd: "fastagent content add ~/code/app", note: "a directory" },
        { cmd: "fastagent content add github:acme/docs", note: "a clone" },
        { cmd: "fastagent content add --program github:acme/docs", note: "for every instance" },
      ],
      notes:
        "Without --program the entry is written to the instance's fastagent.json (the project's, or the file " +
        "--config or FASTAGENT_CONFIG names); a deploy does not carry it yet. github:owner/repo is cloned into " +
        "content/<name> when the agent starts, and brought up to date in place at each start where git can do so " +
        "without touching the agent's work. A directory is used as it is: it must exist, and it may " +
        "hold the agent directory or sit inside it.",
      run: async (args, f) =>
        (await import("./commands/content.ts")).runContentAdd(args[0] as string, args[1] as string, {
          ...(typeof f.ref === "string" ? { ref: f.ref } : {}),
          ...(typeof f.name === "string" ? { name: f.name } : {}),
          ...(typeof f.description === "string" ? { description: f.description } : {}),
          ...(f.program === true ? { program: true } : {}),
          instance: instanceFlags(f),
        }),
    },
    {
      name: "remove",
      summary: "remove a content entry (a directory, and a clone, are left as they are)",
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
  summary: "what will wake this agent up: list, run a schedule now, cancel a wake-up",
  subcommands: [
    {
      name: "list",
      summary: "every schedule (src/schedules/<name>.ts) and wake-up, with when it runs next",
      description:
        "List the schedules this definition declares (defineSchedule in src/schedules/<name>.ts): the next cron " +
        "instant, how the last run ended and the session its runs continue. The agent's own pending wake-ups are listed too, prefixed " +
        "`wake`: a different owner (the STATE, not the definition), cancelled by the agent's `unwake` tool or " +
        "`schedules unwake`. --json adds each schedule's retained fire history. It changes no state.",
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
      description:
        "Fire the schedule <name> now, the way its clock would: in its own session, with its claim and outcome " +
        "recorded (`schedules list` shows them). The answer goes to stdout, the fire's log to stderr; it exits " +
        "non-zero unless its message completed. It opens the instance's storage, so it is refused while `dev` or " +
        "`start` serves this agent, and they are refused while it runs; it is refused too while the instance holds " +
        "messages a stopped serve left unfinished, which it would run and cut off: serve them to their end first.",
      args: [{ name: "<name>", description: "the schedule, as src/schedules/<name>.ts names it" }, AGENT_ARG],
      flags: [
        {
          flags: MODEL.flags,
          description:
            "the default model, as for dev: the schedule's session takes it at its first fire, and keeps the one " +
            "it took after that",
        },
        NO_INPUT,
        ...INSTANCE_FLAGS,
        ...LAYER_FLAGS,
        CONFIG_FLAG,
        ENV_FILE_FLAG,
      ],
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
      summary: "cancel one of the agent's pending wake-ups",
      description:
        "Cancel the pending wake-up <id> (`schedules list` shows the ids), whatever session set it: the way to " +
        "one set where nobody can message the agent, such as a schedule's own session. It is refused while `dev` " +
        "or `start` serves this agent, since a serve's clock writes the same store.",
      args: [{ name: "<id>", description: "the wake-up's id" }, AGENT_ARG],
      flags: [...INSTANCE_FLAGS],
      examples: [{ cmd: "fastagent schedules unwake 3f1c…" }],
      run: async (args, f) =>
        (await import("./commands/schedules.ts")).runUnwake(args[0] as string, args[1] as string, instanceFlags(f)),
    },
  ],
};

/**
 * How an app's setup runs with no one at a terminal: what the person provides is named, and their steps come back with
 * a ticket to check (`channels setup` in docs/cli.md).
 */
const UNATTENDED_SETUP: FlagSpec[] = [
  { flags: "--json", description: "the outcome as one JSON object, with what to do next (agent_next_steps)" },
  { flags: "--check <ticket>", description: "where a setup started without a terminal stands" },
  { flags: "--timeout <seconds>", description: "how long that setup stays open (default 900)" },
  { flags: "--ticket <id>", description: "the process that runs a ticket's setup", hidden: true },
  NO_INPUT,
];

const channels: CommandSpec = {
  name: "channels",
  summary: "a channel's platform app, for one instance",
  subcommands: [
    {
      name: "setup",
      summary: "set up a channel's platform app for one instance, and keep its credentials",
      description:
        "Guide a person through creating the platform app (a Slack app from a manifest link, a Telegram bot from " +
        "BotFather, a Feishu app by scan-to-create, a Lark app on its launcher), ask for the values only they can " +
        "read off its pages, check each with the platform, and keep them in the instance's value file. Safe to run again: a value already there that the platform still accepts is " +
        "kept. How the channel receives (webhook or connection) decides which values it needs: --ingress, else what " +
        "the configuration says, else connection for the development instance and webhook for any other. With no " +
        "terminal (--json), the values are pasted on a page on this machine for the person a coding agent hands the " +
        "step to, never in its conversation. With --record-url: read the deployment's /health, and once <name> (slack, " +
        "or lark where its config API answers 404) is registered there, the platform having reached it at the URL a " +
        "person saved on its app's page, write that URL into the binding (channels.<name>.app.url) of the " +
        "configuration --config names, so every later deploy of it reports it registered from the start.",
      args: [{ name: "<name>", description: "the channel: telegram, slack, feishu or lark" }, AGENT_ARG],
      flags: [
        {
          flags: "--ingress <mode>",
          description: "webhook or connection: set the app up for it, and write it to the configuration",
        },
        {
          flags: "--config <file>",
          description:
            "the instance configuration: how the channel receives is read from it, and --ingress written to it " +
            "(default: the project's fastagent.json, the development instance's)",
        },
        {
          flags: "--env-file <file>",
          description:
            "the value file the credentials are kept in, which must exist; naming it or --config makes this " +
            "another instance than the development one (default: .secrets/.env for dev, else " +
            ".secrets/production/.env, created when missing)",
        },
        {
          flags: "--record-url",
          description: "record the URL the deployment confirms, in the configuration --config names",
        },
        {
          flags: "--url <url>",
          description: "with --record-url: where to read its /health (default: the configuration's http.publicUrl)",
        },
        ...UNATTENDED_SETUP,
      ],
      examples: [
        { cmd: "fastagent channels setup telegram" },
        { cmd: "fastagent channels setup slack --json", note: "an agent" },
        { cmd: "fastagent channels setup slack --config prod.json", note: "a deployment" },
        { cmd: "fastagent channels setup slack --record-url --config c.json" },
      ],
      run: async (args, f) =>
        (await import("./commands/channels.ts")).runChannelsSetup(args[0] as string, args[1] as string, {
          recordUrl: f.recordUrl === true,
          ...(typeof f.ingress === "string" ? { ingress: f.ingress } : {}),
          ...(typeof f.config === "string" ? { config: f.config } : {}),
          ...(typeof f.envFile === "string" ? { envFile: f.envFile } : {}),
          ...(typeof f.url === "string" ? { url: f.url } : {}),
          json: f.json === true,
          input: f.input !== false,
          ...(f.check !== undefined ? { check: f.check as string } : {}),
          ...(f.timeout !== undefined ? { timeout: f.timeout as string } : {}),
          ...(f.ticket !== undefined ? { ticket: f.ticket as string } : {}),
        }),
    },
  ],
};

const SECRETS_HOST = {
  name: "<host>",
  description: "the target that keeps the values",
  choices: ["docker", "fly", "railway", "agentcore"],
};

const secrets: CommandSpec = {
  name: "secrets",
  summary: "a deployment's values, on the target that keeps them",
  subcommands: [
    {
      name: "list",
      summary: "the names the definition declares, and which the target holds",
      description:
        "Print every name the deployment declares (the model's key, `needs()`, `context.json`'s variables, MCP " +
        "references, for the channels its configuration chooses) with whether the target holds a value for it. A value " +
        "is never read back.",
      args: [SECRETS_HOST, AGENT_ARG],
      flags: [
        { flags: "--config <file>", description: "the configuration that names the instance (`deploy --config`)" },
        JSON_FLAG,
      ],
      examples: [{ cmd: "fastagent secrets list fly" }],
      run: async (args, f) =>
        (await import("./commands/secrets.ts")).runSecrets("list", args[0] as "fly", undefined, args[1] as string, {
          ...(typeof f.config === "string" ? { config: f.config } : {}),
          json: f.json === true,
        }),
    },
    {
      name: "set",
      summary: "set one value: typed without echo, from standard input, or generated",
      description:
        "Set one value on the target, creating the app or service when it does not exist. The value is typed without " +
        "echo at a terminal, else read from standard input; it is never an argument. --generate sets a random value " +
        "and prints it once, for what FastAgent makes itself (FASTAGENT_API_KEY).",
      args: [SECRETS_HOST, { name: "<name>", description: "the environment variable" }, AGENT_ARG],
      flags: [
        { flags: "--config <file>", description: "the configuration that names the instance (`deploy --config`)" },
        { flags: "--generate", description: "a random value, printed once" },
      ],
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
      summary: "set every declared value a value file or the environment holds",
      description:
        "Set, in one batch, every declared name the source holds a value for, creating the app or service when it does " +
        "not exist. The source is --env-file, else --from-env (the environment of a command that injected the values: " +
        "`op run`, `doppler run`, `infisical run`, `dotenvx run`, a CI job), else the production value file " +
        "(.secrets/production/.env). Names the definition does not declare are not pushed.",
      args: [SECRETS_HOST, AGENT_ARG],
      flags: [
        { flags: "--config <file>", description: "the configuration that names the instance (`deploy --config`)" },
        { flags: "--env-file <file>", description: "the value file to push from, which must exist" },
        { flags: "--from-env", description: "push from this command's environment" },
      ],
      examples: [
        { cmd: "fastagent secrets push fly" },
        { cmd: "doppler run -- fastagent secrets push fly --from-env", note: "a secret manager" },
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

const INSTANCE_CONFIG: FlagSpec = {
  flags: "--config <file>",
  description:
    "the instance configuration that names the deployment (its `name`; else the program's name), the file `deploy --config` was given",
};

const destroy: CommandSpec = {
  name: "destroy",
  summary: "delete every AWS resource `deploy agentcore` created for an agent",
  description:
    "AgentCore only, and it exists because `aws cloudformation delete-stack` is not enough: the S3 " +
    "artifact bucket, the ECR repository and the values secret have to exist BEFORE the stack that reads from them, BOTH " +
    "log groups (the forwarder's and the runtime's own stdout) are created by AWS on first write so no " +
    "template mentions them, and the EventBridge schedules (one per schedule, one per pending wake-up) " +
    "are minted at runtime by the container — left behind, they keep firing into a deleted Lambda. " +
    "Derives the same names from the instance that deploy did (--config names it). Without --run it deletes nothing and reports what " +
    "is out there.",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, AGENT_ARG],
  flags: [
    INSTANCE_CONFIG,
    { flags: "--run", description: "actually delete. Without it, this is a read-only inventory" },
  ],
  // The other hosts need no command of their own, and saying which one to use belongs where it can be READ:
  // `<host>` has `choices`, so a `destroy fly` never reaches the command body.
  examples: [
    { cmd: "fastagent destroy agentcore", note: "what would be deleted" },
    { cmd: "fastagent destroy agentcore --run", note: "delete it" },
  ],
  notes:
    "A bucket holding anything other than the forwarder's zips is reported and KEPT: an older deploy " +
    "wrote agent state there, and it may be the only copy. Everything else is deleted unconditionally, " +
    "including the agent's session storage on the AgentCore runtime — this host keeps it inside the " +
    "stack, so there is no way to delete the deployment and keep the conversations. The other hosts need " +
    "no command here: `fly apps destroy`, `railway down`, `docker compose -f fastagent.<name>.compose.yml down -v`. " +
    "AWS ONLY: the " +
    "webhook registrations `deploy --run` made with Telegram/Slack/Feishu still point at the deleted " +
    "Function URL, and clearing them is a call to those platforms (for Telegram, deleteWebhook).",
  run: async (args, f) =>
    (await import("./commands/destroy.ts")).runDestroy(args[0] as string, args[1] as string, {
      run: f.run === true,
      ...(typeof f.config === "string" ? { config: f.config } : {}),
    }),
};

const logs: CommandSpec = {
  name: "logs",
  summary: "find and tail a deployed host's application logs",
  description:
    "Find the CloudWatch log group for the AgentCore stack derived from the instance (--config names it), then run aws logs tail. " +
    "The default Runtime source shows the agent process's own stdout/stderr; the forwarder source shows " +
    "the Lambda ingress transport logs.",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, AGENT_ARG],
  flags: [
    INSTANCE_CONFIG,
    { flags: "--source <source>", description: "agentcore log source: runtime (default) or forwarder" },
    { flags: "--since <duration>", description: "history window accepted by AWS CLI (for example 30m or 2h)" },
    { flags: "--follow", description: "keep polling for new log events until interrupted" },
  ],
  examples: [
    { cmd: "fastagent logs agentcore --follow", note: "the agent process" },
    { cmd: "fastagent logs agentcore --source forwarder --follow", note: "Lambda ingress" },
  ],
  notes:
    "Read-only. Run it against the same agent directory and --config passed to deploy so it derives the same CloudFormation " +
    "stack name. It never changes FASTAGENT_LOG_LEVEL: AgentCore keeps start's production default, and " +
    "setting that environment knob to debug exposes the existing detailed turn trace when needed.",
  run: async (args, f) =>
    (await import("./commands/logs.ts")).runLogs(args[0] as string, args[1] as string, {
      ...(typeof f.config === "string" ? { config: f.config } : {}),
      source: f.source as string | undefined,
      since: f.since as string | undefined,
      follow: f.follow === true,
    }),
};

const GLOBAL_AUTH: FlagSpec = {
  flags: "-g, --global",
  description:
    "the global ~/.fastagent/.secrets/auth.json, which every agent here reads for a provider it has no other credential for",
};

const login: CommandSpec = {
  name: "login",
  summary: "sign in to a model provider (an account or an API key)",
  description:
    "Sign in to a model provider into the agent's <agent dir>/.secrets/auth.json (outside an agent it writes the " +
    "global ~/.fastagent/.secrets/auth.json, and says so), as pi's /login does: how to sign in (an account or an API " +
    "key), then the provider, each with what authenticates it now. [provider] (its id or name) skips the provider " +
    "menu; how is asked only when it offers both. An agent READS the global store for a provider it has no other " +
    "credential for (its own file, a provider in its config that authenticates itself, an env variable), so `-g` " +
    "signs in once for every agent on this machine; it warns when an env variable already authenticates the " +
    "provider. Without a terminal (or with --no-input or --json), for a script or a coding agent, nothing is asked " +
    "and nothing waits: a provider or --method not given is answered with the choices and a command for each (exit " +
    "2); an account's sign-in starts in a process of its own and the command returns its address and a ticket at " +
    "once, for the person to sign in at and `login --check <ticket>` to follow; an API key is named, for the person " +
    "to set in the agent's .secrets/.env themselves.",
  args: [{ name: "[provider]", description: "provider id or name (skip the provider menu)" }],
  flags: [
    GLOBAL_AUTH,
    { flags: "--method <how>", description: "account or api-key, for a provider that offers both" },
    { flags: "--json", description: "the outcome as one JSON object, with what to do next (agent_next_steps)" },
    { flags: "--check <ticket>", description: "where a sign-in started without a terminal stands" },
    {
      flags: "--code <address>",
      description: "with --check: the address the browser ended on, when it could not reach this machine",
    },
    {
      flags: "--timeout <seconds>",
      description: "how long the sign-in stays open (default 600 without a terminal)",
    },
    { flags: "--ticket <id>", description: "the process that runs a ticket's sign-in", hidden: true },
    {
      flags: "--deployment <host>",
      description:
        "log in this agent's deployment on <host> instead, on the box itself (docker, fly, railway, agentcore)",
    },
    {
      flags: "--config <file>",
      description:
        "with --deployment: the instance configuration that names the deployment (the file `deploy --config` was given)",
    },
    { flags: "--stdio", description: "the box's half of --deployment", hidden: true },
    { flags: "--if-missing", description: "with --stdio: keep a stored credential for the provider", hidden: true },
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent login" },
    { cmd: "fastagent login openai", note: "ChatGPT, or an API key" },
    { cmd: "fastagent login openai -g", note: "for every agent here" },
    { cmd: "fastagent login openai --method account --json", note: "an agent" },
    { cmd: "fastagent login --check 3f9a0c1d2e4b5a67 --json", note: "then" },
    { cmd: "fastagent login openai --deployment fly", note: "on the box" },
  ],
  notes:
    "The positional is the PROVIDER (not a dir) — `cd` into your agent before logging in. Exit status: 0 signed in " +
    "or waiting on the person (need_user_action), 1 cancelled, failed or expired, 2 a provider or method not given. " +
    "--deployment runs the login on the deployed box through the host's own shell (docker compose exec, fly ssh, " +
    "railway ssh, AgentCore's command shell); this terminal shows it, opens the browser, and catches the browser's " +
    "return to localhost (or asks you to paste that address when its port is taken). The box keeps the credential, " +
    "so it is the only holder of that grant, and logging in again replaces it there. Without a terminal, an " +
    "account's sign-in on the box returns a ticket as a local one does, its process holding the box's shell; an API " +
    "key is named, for the person to set in .secrets/production/.env before the next deploy carries it.",
  run: async (args, f) =>
    (await import("./commands/login.ts")).runLogin(args[0] as string | undefined, {
      global: f.global === true,
      input: f.input !== false,
      json: f.json === true,
      ...(f.method !== undefined ? { method: f.method as string } : {}),
      ...(f.timeout !== undefined ? { timeout: f.timeout as string } : {}),
      ...(f.check !== undefined ? { check: f.check as string } : {}),
      ...(f.code !== undefined ? { code: f.code as string } : {}),
      ...(f.ticket !== undefined ? { ticket: f.ticket as string } : {}),
      ...(f.deployment !== undefined ? { deployment: f.deployment as string } : {}),
      ...(typeof f.config === "string" ? { config: f.config } : {}),
      stdio: f.stdio === true,
      ifMissing: f.ifMissing === true,
    }),
};

const logout: CommandSpec = {
  name: "logout",
  summary: "remove a provider's stored credential",
  description:
    "Remove the credential `login` stored for a provider, from the agent's <agent dir>/.secrets/auth.json (outside " +
    "an agent, or with -g, the global file), as pi's /logout does: a menu of the providers stored there, or the one " +
    "named. Environment variables, and the grant at the provider, are left as they are.",
  args: [{ name: "[provider]", description: "provider id or name (required without a terminal)" }],
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
  summary: "check a model provider's credential (for scripts and agents)",
  subcommands: [
    {
      name: "check",
      summary: "is a provider ready: prints ready, not_ready or invalid",
      description:
        "Check what authenticates a provider for the agent here (outside an agent, or with -g, for the global " +
        "file), as pi's `auth check` does: prints ready, not_ready or invalid, and exits 0, 1 or 2. --model names " +
        "the provider by a model of it; a login due a refresh is refreshed, as a message would. --json prints " +
        "{status, provider, authType | reason, source, path}.",
      flags: [
        { flags: "--provider <id>", description: "the provider to check" },
        { flags: "--model <provider/modelId>", description: "the provider of this model" },
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
      description: "Read the declared MCP servers and local grant metadata without contacting servers.",
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
      summary: "sign in to an MCP server",
      description: "Authorize in the browser and save an explicit grant binding for this instance.",
      examples: [
        { cmd: "fastagent mcp login linear --scopes read --json" },
        { cmd: "fastagent mcp login --check <ticket> --json" },
      ],
      args: [
        { name: "[server]", description: "the name of an MCP server the program or the instance declares" },
        AGENT_ARG,
      ],
      flags: [
        CHANNEL_ENVIRONMENT,
        ...UNATTENDED_SETUP,
        { flags: "--scopes <scopes>", description: "comma-separated OAuth scopes; required without a terminal" },
        { flags: "--client-id <id>", description: "a pre-registered public client ID or client metadata URL" },
        { flags: "--callback-port <port>", description: "local callback port (default: allocate an available port)" },
      ],
      run: async (args, f) =>
        (await import("./commands/mcp.ts")).runMcp("login", args[0] as string | undefined, args[1] as string, {
          json: f.json === true,
          input: f.input !== false,
          environment: f.env as string | undefined,
          scopes: f.scopes as string | undefined,
          clientId: f.clientId as string | undefined,
          callbackPort: f.callbackPort as string | undefined,
          check: f.check as string | undefined,
          ticket: f.ticket as string | undefined,
          timeout: f.timeout as string | undefined,
        }),
    },
    {
      name: "disconnect",
      summary: "remove a local OAuth binding",
      description:
        "Remove this instance's binding without revoking or deleting a shared grant. Reopen running instances afterward.",
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

/**
 * Registration order = help order — the ORIGINAL usage wall's order, kept verbatim (this is a commander refactor of
 * the same CLI, not a redesign).
 */
export const specs: readonly CommandSpec[] = [
  init,
  models,
  mcp,
  info,
  build,
  content,
  env,
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
  // Before any command loads the storage: an older Bun fails that import with a message that says nothing of Bun.
  const unsupported = unsupportedRuntime();
  if (unsupported !== undefined) failStartup(new Error(unsupported));
  await buildCliProgram({ version: await fastagentVersion() }).parseAsync([...argv]);
}
