/**
 * The fastagent command registry: every command as data ({@link CommandSpec}) with a lazy-imported implementation, so
 * `fastagent <cmd>` pays only for the module graph that command actually uses.
 */
import { fastagentVersion } from "../version.ts";
import { buildProgram, type CommandSpec, type FlagSpec, type ProgramOptions } from "./kernel.ts";
import { DEPLOY_HOSTS, type DeployHost } from "../deploy/hosts.ts";

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
const NO_INVOKE: FlagSpec = {
  flags: "--no-invoke",
  description:
    "do not serve POST /invoke on this run — it is unauthenticated and runs a turn with the agent's full tools, so " +
    "a serve meant to be reached only through its channels' signed webhooks should withhold it " +
    "(fastagent.config.ts http.invoke: false is the same choice, but it travels into a deployed image)",
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
    "self-iterating agent: APPEND_SYSTEM.md (its standing instructions), a writing-great-skills " +
    "example skill, a fetch-url code tool, config, package.json, .gitignore.",
  args: [{ name: "<dir>", description: "the new agent's directory (created when missing)" }],
  flags: [
    {
      flags: "--context <source>",
      description:
        "a directory or github:owner/repo the agent works on (repeatable); declared in fastagent.config.ts `contexts`",
      repeatable: true,
    },
    { flags: "--no-install", description: "scaffold everything but skip npm install" },
  ],
  examples: [
    { cmd: "fastagent init my-agent", note: "an agent that only talks" },
    { cmd: "fastagent init reviewer --context ~/code/app", note: "works on ~/code/app" },
    { cmd: "fastagent init triage --context github:acme/app", note: "works on a clone" },
  ],
  notes:
    "An agent is a directory holding a fastagent.config.ts, and it is also the agent's working directory. " +
    "It lives in a directory of its own, never inside a project or another agent: what it works on is declared " +
    "as a context. Add one it only knows later with `fastagent context add <dir> --readonly`.",
  run: async (args, f) =>
    (await import("./commands/init.ts")).runInit(args[0] as string, {
      install: f.install !== false,
      contexts: (f.context as string[] | undefined) ?? [],
    }),
};

const dev: CommandSpec = {
  name: "dev",
  summary: "serve the agent locally, restarting on code edits",
  description:
    "Assemble the agent (default .) and serve a local HTTP channel. SYSTEM.md/APPEND_SYSTEM.md/" +
    "skills/prompts " +
    "are re-read every turn (edits go live next turn); edits to code inputs — tools/, channels/, " +
    "fastagent.config.ts, package.json, .secrets/.env — restart the worker once its running turns finish. " +
    "Files the agent writes as " +
    "work product never trigger a restart.",
  args: [AGENT_ARG],
  flags: [
    PORT,
    BIND,
    MODEL,
    { flags: "--no-watch", description: "serve once, no file-watching" },
    TUNNEL,
    NO_INVOKE,
    NO_INPUT,
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
      ...(f.invoke === false ? { invoke: false as const } : {}),
      input: f.input !== false,
    }),
};

const chat: CommandSpec = {
  name: "chat",
  summary: "open the SAME assembled agent in pi's interactive TUI",
  description:
    "Open the SAME assembled agent in pi's interactive TUI (the real harness, not a crude REPL) — to " +
    "try it locally before serving. Same model/tool/skill/auth resolution as dev; pi handles " +
    "rendering, sessions, and /resume natively (its /login writes to the same fastagent auth file).",
  args: [AGENT_ARG],
  flags: [MODEL],
  examples: [{ cmd: "fastagent chat" }],
  run: async (args, f) =>
    (await import("./commands/chat.ts")).runChat(args[0] as string, { model: f.model as string | undefined }),
};

const info: CommandSpec = {
  name: "info",
  summary: "print what the directory assembles into, without serving",
  description:
    "Print what the agent (default .) ASSEMBLES into — model, prompt, skills, " +
    "tools (+ collisions), channels, schedules, sessions, load diagnostics — WITHOUT serving. " +
    "Read-only (never creates sessions / writes .gitignore); an unset model is reported, not fatal. " +
    "Run it first when something looks off.",
  args: [AGENT_ARG],
  flags: [JSON_FLAG, MODEL],
  examples: [{ cmd: "fastagent info" }, { cmd: "fastagent info --json", note: "for CI" }],
  run: async (args, f) =>
    (await import("./commands/info.ts")).runInfo(args[0] as string, {
      json: f.json === true,
      model: f.model as string | undefined,
    }),
};

const tool: CommandSpec = {
  name: "tool",
  summary: "run one tool directly with JSON args — no model, no server, no tokens",
  description:
    "Run one tool (from tools/ or config.tools) directly with JSON args — no model, no server, no " +
    "tokens. Fast feedback while authoring a tool.",
  args: [
    { name: "<name>", description: "the tool name as served (see `fastagent info`)" },
    { name: "[json-args]", description: "the tool's arguments as a JSON object", default: "{}" },
    AGENT_ARG,
  ],
  examples: [{ cmd: `fastagent tool add '{"a":2,"b":3}'` }],
  notes:
    "Mounts the same tool set dev/start serve (all coding tools + config.tools + discovered tools/, " +
    "deduped), so a shadowed or broken tool is surfaced here exactly as it would be when serving.",
  run: async (args) =>
    (await import("./commands/tool.ts")).runTool(args[0] as string, args[1] as string, args[2] as string),
};

const invoke: CommandSpec = {
  name: "invoke",
  summary: "run ONE turn against the assembled agent and exit",
  description:
    "Run ONE turn against the assembled agent and exit — no server, no TUI. The reply streams to " +
    "stdout, tool/diagnostics to stderr, a failed turn exits non-zero. The all-agent counterpart of " +
    "`tool`, for CI smoke and quick checks. Same model resolution as dev.",
  args: [{ name: "<message>", description: "the user message for the turn" }, AGENT_ARG],
  flags: [MODEL, NO_INPUT],
  examples: [{ cmd: `fastagent invoke "summarize today's inbox"` }],
  run: async (args, f) =>
    (await import("./commands/invoke.ts")).runInvoke(args[0] as string, args[1] as string, {
      model: f.model as string | undefined,
      input: f.input !== false,
    }),
};

const models: CommandSpec = {
  name: "models",
  summary: 'list the available "provider/modelId" model specs',
  description:
    'List every "provider/modelId" spec the agent in this directory can name (pi\'s built-ins, the model ' +
    "catalogs and models.json files, its own over the machine's) — use one with --model or as `model` in " +
    "fastagent.config.ts. Outside an agent, or with -g, list the machine's.",
  args: [{ name: "[search]", description: "case-insensitive substring filter" }],
  flags: [
    {
      flags: "--refresh",
      description: "fetch the model catalog first, into the agent's models-store.json (with -g, the machine's)",
    },
    { flags: "-g, --global", description: "the machine's catalog, ~/.fastagent/models-store.json" },
  ],
  examples: [
    { cmd: "fastagent models", note: "all specs" },
    { cmd: "fastagent models claude", note: "filter; provider-name matches rank first" },
    { cmd: "fastagent models --refresh", note: "models newer than the installed pi" },
  ],
  notes:
    "A refresh asks pi.dev for the providers the scope's credentials authenticate (the agent's, or with -g the " +
    "global auth.json and environment) and writes the answer to models-store.json. The agent's is part of the " +
    "definition: commit it, and it ships with a deploy. The machine's (-g) is read by every agent here and does " +
    "not ship. Nothing refreshes on its own.",
  run: async (args, f) =>
    (await import("./commands/models.ts")).runModels(args[0], {
      refresh: f.refresh === true,
      global: f.global === true,
    }),
};

const start: CommandSpec = {
  name: "start",
  summary: "run the agent in production posture (same assembly as dev, no watching)",
  description:
    "Run the agent (default .) in production posture — the SAME assembly as dev (your directory " +
    "is the agent), just no file-watching. No build step: start reads the definition directly; " +
    "model/http come from fastagent.config.ts (frozen by git).",
  args: [AGENT_ARG],
  flags: [PORT, BIND, MODEL, TUNNEL, NO_INVOKE, NO_INPUT],
  examples: [
    { cmd: "fastagent start" },
    { cmd: "fastagent start --tunnel", note: "host a bot from your own box, no deploy" },
  ],
  notes:
    "Precedence chains:\n" +
    "  port:     --port > PORT env > fastagent.config.ts http.port > 8787\n" +
    "  bind:     --bind > all interfaces (dev: 127.0.0.1)\n" +
    "  /invoke:  --no-invoke > fastagent.config.ts http.invoke > served\n" +
    "  state:    FASTAGENT_STATE_DIR > <agent dir>/.state — mutable machine state\n" +
    "            (sessions, channel state, schedule state); point it at a mounted\n" +
    "            volume so a redeploy that replaces the directory never wipes it\n" +
    "  secrets:  FASTAGENT_SECRETS_DIR > <agent dir>/.secrets — .env + auth.json\n" +
    "  clones:   FASTAGENT_CONTEXTS_DIR > <agent dir>/.contexts — github contexts\n" +
    "  sessions: <state>/sessions — no separate knob; move the state root\n" +
    "  auth:     FASTAGENT_AUTH_PATH > <secrets>/auth.json\n" +
    "            (project-level; point it at ~/.fastagent/.secrets/auth.json to\n" +
    "            share one credential across projects)\n" +
    "  endpoints: FASTAGENT_MODELS_PATH > ~/.fastagent/models.json, under the agent's\n" +
    "            own models.json (the machine's; it does not ship with a deploy)",
  run: async (args, f) =>
    (await import("./commands/start.ts")).runStart(args[0] as string, {
      port: f.port as string | undefined,
      bind: f.bind as string | undefined,
      model: f.model as string | undefined,
      tunnel: f.tunnel === true,
      ...(f.invoke === false ? { invoke: false as const } : {}),
      input: f.input !== false,
    }),
};

const INGRESS: FlagSpec = {
  flags: "--ingress <mode>",
  description: "Feishu/Lark ingress: websocket (default) or webhook (AgentCore, scale-to-zero)",
};
const NO_ONBOARD: FlagSpec = {
  flags: "--no-onboard",
  description: "Slack: scaffold only; skip internal-app creation/OAuth",
};
const REPLACE_CONFIG: FlagSpec = {
  flags: "--replace-config",
  description:
    "Slack: replace the local App Configuration token pair (repairs automatic dev/deploy Request URL " +
    "updates after the tokens expire or are revoked; runs on the machine that onboarded the app)",
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
  flags: kind === "feishu" || kind === "lark" ? [INGRESS] : kind === "slack" ? [NO_ONBOARD, REPLACE_CONFIG] : [],
  examples: [{ cmd: `fastagent add ${kind}` }],
  ...(notes ? { notes } : {}),
  run: async (args, f) =>
    (await import("./commands/add.ts")).runAddChannel(kind, args[0] as string, {
      ingress: f.ingress as string | undefined,
      onboard: f.onboard !== false,
      replaceConfig: f.replaceConfig === true,
    }),
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
      "scaffold the Telegram bot channel (durable turns, live preview)",
      "Scaffold channels/telegram.ts — the Telegram bot channel with durable turns, a live-preview " +
        "message pump, and an optional route() policy.",
    ),
    channelSub(
      "slack",
      "scaffold the Slack Events API channel (files, threads, context, live preview)",
      "Scaffold channels/slack.ts plus slack-send.ts, create a single-workspace " +
        "internal Slack app from a manifest, and install it through OAuth. The channel provides signed " +
        "Events API ingress, durable turns, files, threads, context, and an edited live preview.",
      "Automated onboarding requires Slack App Configuration access + refresh tokens and a temporary " +
        "cloudflared tunnel. They stay in owner-readable local state and are never deployed; --no-onboard " +
        "keeps the explicit manual/scaffold-only path.",
    ),
    channelSub(
      "feishu",
      "scaffold the Feishu channel AND create/configure the platform app",
      "Choose WebSocket or webhook, scaffold channels/feishu.ts, and create/configure the Feishu app " +
        "through scan-to-create, writing the matching credentials to .env.",
      "Feishu (open.feishu.cn) is the canonical implementation. WebSocket needs only App ID/Secret and " +
        "no public URL; webhook additionally captures the Verification Token through a temporary tunnel. " +
        "The app asks for the scopes that let the agent hear its group chats; any your tenant withholds are named.",
    ),
    channelSub(
      "lark",
      "scaffold the Lark (international) channel with guided credential setup",
      "Choose WebSocket or webhook, scaffold channels/lark.ts, and guide credential setup against the " +
        "international developer console.",
      "Lark international (open.larksuite.com) is Feishu's compatibility profile. WebSocket stops after " +
        "App ID/Secret validation and a permission check; webhook setup probes config automation and falls " +
        "back to explicit manual steps on the international config-route 404.",
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
        (await import("./commands/add.ts")).runAddSkill(args[0], args[1] as string, { update: f.update === true }),
    },
  ],
};

const deploy: CommandSpec = {
  name: "deploy",
  summary: "generate deploy artifacts + a runbook for docker, fly, railway, or agentcore (--run drives it)",
  description:
    "Generate Dockerfile/.dockerignore plus the target config and print an ordered runbook. " +
    "docker: fastagent.compose.yml, loopback port, persistent state volume. fly: fly.toml " +
    "(autostop=suspend, state→volume). railway: no config file; its volume/variables/App-Sleeping " +
    "are dashboard/CLI steps the runbook states. agentcore: one " +
    "CloudFormation stack (AWS Bedrock AgentCore Runtime + forwarder Lambda for webhooks + " +
    "the alarms the container sets for schedules and wake-ups; linux/arm64 image built locally). Durable ingress " +
    "remains operator-owned (agentcore's forwarder URL is the exception — the stack owns it).",
  args: [{ name: "<host>", description: "deploy target", choices: [...DEPLOY_HOSTS] }, AGENT_ARG],
  flags: [
    {
      flags: "--run",
      description:
        "drive the target CLI to completion. Docker runs `docker compose up -d --build`; with a tunnel " +
        "service, reads its URL and registers webhooks. Fly/Railway provision app/service + volume + " +
        "secrets + deploy + webhook setup. AgentCore builds/pushes the arm64 image and deploys the " +
        "stack (aws + docker CLIs). A model key in the value file travels; any other credential is a login on " +
        "the deployment itself, which --run starts once the box is up (fastagent login --deployment). " +
        "Stops at a gate (missing CLI/daemon/login/secret) with one actionable line. Without it: prints " +
        "the runbook",
    },
    {
      flags: "--tunnel",
      description:
        "(docker only) add a Quick Tunnel service to generated Compose; generation-only unless combined " +
        "with --run. Existing Compose stays authoritative",
    },
    { flags: "--force", description: "overwrite existing target config/Dockerfile/.dockerignore (else kept)" },
    {
      flags: "--into-linked",
      description:
        "(railway --run) provision INTO the project this dir is already linked to (skip create); by " +
        "default --run refuses a pre-existing link (could be unrelated/production)",
    },
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent deploy fly --run", note: "provision + deploy + webhooks" },
    { cmd: "fastagent deploy docker --tunnel --run", note: "Compose + a public URL" },
    { cmd: "fastagent deploy railway", note: "print the runbook only" },
    { cmd: "fastagent deploy agentcore --run", note: "arm64 image + stack + webhooks" },
  ],
  notes:
    "Definition-read-only: the only writes are generated artifacts (never clobbered without " +
    "--force). A plain redeploy of an already-provisioned agent is just the host's own command " +
    "(e.g. `railway up`).",
  run: async (args, f) =>
    (await import("./commands/deploy.ts")).runDeploy(args[0] as DeployHost, args[1] as string, {
      run: f.run === true,
      tunnel: f.tunnel === true,
      force: f.force === true,
      intoLinked: f.intoLinked === true,
      input: f.input !== false,
    }),
};

const context: CommandSpec = {
  name: "context",
  summary: "list, add or remove what the agent works on and knows",
  description:
    "A context is a directory the agent works on (or only knows, with --readonly), declared in the literal " +
    "`contexts` list of fastagent.config.ts. These commands edit only that list, and refuse when it is computed.",
  subcommands: [
    {
      name: "list",
      summary: "each context, where it is, and whether the agent works on it or only knows it",
      args: [AGENT_ARG],
      flags: [JSON_FLAG],
      examples: [{ cmd: "fastagent context list" }],
      run: async (args, f) =>
        (await import("./commands/context.ts")).runContextList(args[0] as string, f.json === true),
    },
    {
      name: "add",
      summary: "declare a directory or a GitHub repository as a context",
      args: [{ name: "<source>", description: "a directory, or github:owner/repo" }, AGENT_ARG],
      flags: [
        { flags: "--readonly", description: "the agent knows it and does not write it" },
        { flags: "--ref <ref>", description: "a repository: the branch, tag or commit to clone" },
        { flags: "--local <dir>", description: "github:owner/repo: its checkout on this machine" },
        { flags: "--name <name>", description: "its name (default: the directory's or repository's)" },
      ],
      examples: [
        { cmd: "fastagent context add ~/code/app", note: "works on" },
        { cmd: "fastagent context add ~/handbook --readonly", note: "knows" },
        { cmd: "fastagent context add github:acme/docs --readonly", note: "knows a clone" },
      ],
      notes:
        "The root of a GitHub checkout is declared `{ github, local }`: the repository, with that checkout " +
        "used as it is on this machine. A repository with no checkout here is cloned, and brought up to date in " +
        "place at each start where git can do so without touching the agent's work. Any other directory is " +
        "declared `{ local }`: it stays on this machine, and a deployed instance works without it. A context may not contain " +
        "the agent directory, nor sit inside it.",
      run: async (args, f) =>
        (await import("./commands/context.ts")).runContextAdd(args[0] as string, args[1] as string, {
          readonly: f.readonly === true,
          ...(typeof f.ref === "string" ? { ref: f.ref } : {}),
          ...(typeof f.local === "string" ? { local: f.local } : {}),
          ...(typeof f.name === "string" ? { name: f.name } : {}),
        }),
    },
    {
      name: "remove",
      summary: "remove a context from the declaration (the directory itself is untouched)",
      args: [{ name: "<name>", description: "the context's name" }, AGENT_ARG],
      examples: [{ cmd: "fastagent context remove app" }],
      run: async (args) =>
        (await import("./commands/context.ts")).runContextRemove(args[0] as string, args[1] as string),
    },
  ],
};

const schedules: CommandSpec = {
  name: "schedules",
  summary: "list what will wake this agent up: its schedules and its own wake-ups",
  subcommands: [
    {
      name: "list",
      summary: "every schedule (schedules/<name>.md) and wake-up, with when it runs next",
      description:
        "List the schedules this definition declares (schedules/<name>.md): the next cron instant, how the last " +
        "run ended and the session its turns run in. The agent's own pending wake-ups are listed too, prefixed " +
        "`wake`: a different owner (the STATE, not the definition), and only the agent cancels them (the `unwake` " +
        "tool). --json adds each schedule's retained fire history. Read-only.",
      args: [AGENT_ARG],
      flags: [JSON_FLAG],
      examples: [{ cmd: "fastagent schedules list" }],
      run: async (args, flags) =>
        (await import("./commands/schedules.ts")).runSchedulesList(args[0] as string, flags.json === true),
    },
  ],
};

const destroy: CommandSpec = {
  name: "destroy",
  summary: "delete every AWS resource `deploy agentcore` created for an agent",
  description:
    "AgentCore only, and it exists because `aws cloudformation delete-stack` is not enough: the S3 " +
    "artifact bucket and the ECR repository have to exist BEFORE the stack that reads from them, BOTH " +
    "log groups (the forwarder's and the runtime's own stdout) are created by AWS on first write so no " +
    "template mentions them, and the EventBridge schedules (one per schedules/ file, one per pending wake-up) " +
    "are minted at runtime by the container — left behind, they keep firing into a deleted Lambda. " +
    "Derives the same names from the agent directory that deploy did. Without --run it deletes nothing and reports what " +
    "is out there.",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, AGENT_ARG],
  flags: [{ flags: "--run", description: "actually delete. Without it, this is a read-only inventory" }],
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
    "no command here: `fly apps destroy`, `railway down`, `docker compose -f fastagent.compose.yml down -v`. " +
    "AWS ONLY: the " +
    "webhook registrations `deploy --run` made with Telegram/Slack/Feishu still point at the deleted " +
    "Function URL, and clearing them is a call to those platforms (for Telegram, deleteWebhook).",
  run: async (args, f) =>
    (await import("./commands/destroy.ts")).runDestroy(args[0] as string, args[1] as string, {
      run: f.run === true,
    }),
};

const logs: CommandSpec = {
  name: "logs",
  summary: "find and tail a deployed host's application logs",
  description:
    "Find the CloudWatch log group for the AgentCore stack derived from the agent directory, then run aws logs tail. " +
    "The default Runtime source shows the agent process's own stdout/stderr; the forwarder source shows " +
    "the Lambda ingress transport logs.",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, AGENT_ARG],
  flags: [
    { flags: "--source <source>", description: "agentcore log source: runtime (default) or forwarder" },
    { flags: "--since <duration>", description: "history window accepted by AWS CLI (for example 30m or 2h)" },
    { flags: "--follow", description: "keep polling for new log events until interrupted" },
  ],
  examples: [
    { cmd: "fastagent logs agentcore --follow", note: "the agent process" },
    { cmd: "fastagent logs agentcore --source forwarder --follow", note: "Lambda ingress" },
  ],
  notes:
    "Read-only. Run it against the same agent directory passed to deploy so it derives the same CloudFormation " +
    "stack name. It never changes FASTAGENT_LOG_LEVEL: AgentCore keeps start's production default, and " +
    "setting that environment knob to debug exposes the existing detailed turn trace when needed.",
  run: async (args, f) =>
    (await import("./commands/logs.ts")).runLogs(args[0] as string, args[1] as string, {
      source: f.source as string | undefined,
      since: f.since as string | undefined,
      follow: f.follow === true,
    }),
};

const login: CommandSpec = {
  name: "login",
  summary: "authenticate a model provider (subscription/OAuth or API key)",
  description:
    "Authenticate a model provider into the project-level <agent dir>/.secrets/auth.json (outside an " +
    "agent it writes the global ~/.fastagent/.secrets/auth.json, and says so): pick a method " +
    "(subscription/OAuth or API " +
    "key), then a provider that offers it (configured status shown). [provider] takes the method from " +
    "what that provider supports, asked only when both. An agent READS the global store for a provider it has " +
    "no other credential for (its own file, a models.json key, an env variable), so `-g` logs in once for every " +
    "agent on this machine; it warns when an env variable already authenticates the provider.",
  args: [{ name: "[provider]", description: "provider id (skip the provider menu)" }],
  flags: [
    {
      flags: "-g, --global",
      description: `store in ~/.fastagent/.secrets/auth.json — every agent here reads it for a provider it has no other credential for`,
    },
    {
      flags: "--deployment <host>",
      description:
        "log in this agent's deployment on <host> instead, on the box itself (docker, fly, railway, agentcore)",
    },
    { flags: "--stdio", description: "the box's half of --deployment", hidden: true },
    { flags: "--if-missing", description: "with --stdio: keep a stored credential for the provider", hidden: true },
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent login" },
    { cmd: "fastagent login openai" },
    { cmd: "fastagent login openai -g" },
    { cmd: "fastagent login openai-codex --deployment fly", note: "on the box" },
  ],
  notes:
    "The positional is the PROVIDER (not a dir) — `cd` into your agent before logging in. " +
    "--deployment runs the login on the deployed box through the host's own shell (docker compose exec, fly ssh, " +
    "railway ssh, AgentCore's command shell); this terminal shows it, opens the browser, and catches the browser's " +
    "return to localhost (or asks you to paste that address when its port is taken). The box keeps the credential, " +
    "so it is the only holder of that grant, and logging in again replaces it there.",
  run: async (args, f) =>
    (await import("./commands/login.ts")).runLogin(args[0], {
      global: f.global === true,
      input: f.input !== false,
      ...(f.deployment !== undefined ? { deployment: f.deployment as string } : {}),
      stdio: f.stdio === true,
      ifMissing: f.ifMissing === true,
    }),
};

/**
 * Registration order = help order — the ORIGINAL usage wall's order, kept verbatim (this is a commander refactor of
 * the same CLI, not a redesign).
 */
export const specs: readonly CommandSpec[] = [
  init,
  models,
  info,
  context,
  tool,
  invoke,
  schedules,
  dev,
  chat,
  start,
  add,
  deploy,
  logs,
  destroy,
  login,
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
  await buildCliProgram({ version: await fastagentVersion() }).parseAsync([...argv]);
}
