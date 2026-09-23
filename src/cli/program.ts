/**
 * The fastagent command registry: every command as data ({@link CommandSpec}) with a lazy-imported implementation, so
 * `fastagent <cmd>` pays only for the module graph that command actually uses.
 */
import { fastagentVersion } from "../version.ts";
import { buildProgram, type CommandSpec, type FlagSpec, type ProgramOptions } from "./kernel.ts";
import { DEPLOY_HOSTS, type DeployHost } from "../deploy/hosts.ts";

// Help groups (clig: most common commands first) — the authoring loop leads, operations close.
const DIR_ARG = {
  name: "[dir]",
  description: "workspace directory (the agent is here, or in a directory inside it)",
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
    "do not serve POST /invoke on this run, nor POST /run — both are unauthenticated and run a turn with the " +
    "agent's full tools, so a serve meant to be reached only through its channels' signed webhooks should withhold " +
    "them (fastagent.config.ts http.invoke: false is the same choice, but it travels into a deployed image; this " +
    "flag outranks http.run: true, because a flag is what a definition you cannot edit still answers to)",
};
const TUNNEL: FlagSpec = {
  flags: "--tunnel",
  description:
    "expose a public HTTPS URL via a Cloudflare quick tunnel (needs cloudflared) and auto-register " +
    "webhook channels (telegram, onboarded slack, feishu, lark; github/manual slack print the URL) — for hosting a bot from your " +
    "own box without deploying (the quick-tunnel URL is ephemeral, not for production)",
};

const init: CommandSpec = {
  name: "init",
  summary: "scaffold a runnable agent and install its dependencies",
  description:
    "Scaffold a runnable agent and run npm install. The agent ALWAYS goes into a subdirectory of dir " +
    "(default .): ./fastagent/, or --agent-dir <name> — the rest of the directory gets zero writes, and " +
    "it is the WORKSPACE the agent works ON when you point fastagent there. Content is a " +
    "self-iterating agent: persona.md (its identity), a writing-great-skills " +
    "example skill, a fetch-url code tool, config, package.json, .gitignore. An existing AGENTS.md is " +
    "kept as project context.",
  args: [DIR_ARG],
  flags: [
    { flags: "--no-install", description: "scaffold everything but skip npm install" },
    { flags: "--agent-dir <name>", description: "name the agent directory (default fastagent)" },
  ],
  examples: [
    { cmd: "fastagent init", note: "the agent lands in ./fastagent/" },
    { cmd: "fastagent init my-project", note: "my-project/fastagent/ (created)" },
    { cmd: "fastagent init . --agent-dir bot", note: "./bot/ — any name works" },
  ],
  notes:
    "An agent is a directory holding a fastagent.config.ts — never its NAME, so --agent-dir can call it " +
    "anything (the name decides only which agent answers when a workspace holds several: see " +
    "FASTAGENT_AGENT). What the agent works ON (its cwd, where its AGENTS.md context is read from) is " +
    "whatever directory you later point fastagent at: point at the project and the agent inside it " +
    "serves with the project as its workspace; point at the agent directory and it works on itself. " +
    "A directory resolves to ONE agent, at it or one level inside.",
  run: async (args, f) =>
    (await import("./commands/init.ts")).runInit(args[0] as string, {
      install: f.install !== false,
      agentDir: typeof f.agentDir === "string" ? f.agentDir : undefined,
    }),
};

const dev: CommandSpec = {
  name: "dev",
  summary: "serve the agent locally, restarting on code edits",
  description:
    "Assemble the agent in dir (default .) and serve a local HTTP channel. persona.md/AGENTS.md/skills and " +
    "TypeScript tools/ are re-read every turn (edits go live next turn); edits to code inputs — channels/, " +
    "routines/, fastagent.config.ts, package.json, .secrets/.env, other files in tools/ — restart the worker. Files the agent writes as " +
    "work product never trigger a restart.",
  args: [DIR_ARG],
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
  args: [DIR_ARG],
  flags: [MODEL],
  examples: [{ cmd: "fastagent chat" }],
  run: async (args, f) =>
    (await import("./commands/chat.ts")).runChat(args[0] as string, { model: f.model as string | undefined }),
};

const info: CommandSpec = {
  name: "info",
  summary: "print what the directory assembles into, without serving",
  description:
    "Print what dir (default .) ASSEMBLES into — model, persona, context files (AGENTS.md), skills, " +
    "tools (+ collisions), channels, schedules, sessions, load diagnostics — WITHOUT serving. " +
    "Read-only (never creates sessions / writes .gitignore); an unset model is reported, not fatal. " +
    "Run it first when something looks off.",
  args: [DIR_ARG],
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
    DIR_ARG,
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
  args: [{ name: "<message>", description: "the user message for the turn" }, DIR_ARG],
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
    'List every registered "provider/modelId" spec — use one with --model or as `model` in fastagent.config.ts.',
  args: [{ name: "[search]", description: "case-insensitive substring filter" }],
  examples: [
    { cmd: "fastagent models", note: "all specs" },
    { cmd: "fastagent models claude", note: "filter; provider-name matches rank first" },
  ],
  run: async (args) => (await import("./commands/models.ts")).runModels(args[0]),
};

const start: CommandSpec = {
  name: "start",
  summary: "run the agent in production posture (same assembly as dev, no watching)",
  description:
    "Run the agent in dir (default .) in production posture — the SAME assembly as dev (your directory " +
    "is the agent), just no file-watching. No build step: start reads the definition directly; " +
    "model/http come from fastagent.config.ts (frozen by git).",
  args: [DIR_ARG],
  flags: [PORT, BIND, MODEL, TUNNEL, NO_INVOKE, NO_INPUT],
  examples: [
    { cmd: "fastagent start" },
    { cmd: "fastagent start --tunnel", note: "host a bot from your own box, no deploy" },
  ],
  notes:
    "Precedence chains:\n" +
    "  port:     --port > PORT env > fastagent.config.ts http.port > 8787\n" +
    "  bind:     --bind > fastagent.config.ts http.host > all interfaces\n" +
    "  /invoke:  --no-invoke > fastagent.config.ts http.invoke > served\n" +
    "  /run:     --no-invoke > fastagent.config.ts http.run > http.invoke\n" +
    "            (with GET /routines; both only where routines/ declares something)\n" +
    "  state:    FASTAGENT_STATE_DIR > <agent dir>/.state — mutable machine state\n" +
    "            (sessions, channel state, schedule state); point it at a mounted\n" +
    "            volume so a redeploy that replaces the directory never wipes it\n" +
    "  secrets:  FASTAGENT_SECRETS_DIR > <agent dir>/.secrets — .env + auth.json\n" +
    "  sessions: <state>/sessions — no separate knob; move the state root\n" +
    "  auth:     FASTAGENT_AUTH_PATH > <secrets>/auth.json\n" +
    "            (project-level; point it at ~/.fastagent/.secrets/auth.json to\n" +
    "            share one credential across projects)",
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
  description: "Feishu/Lark ingress: websocket or webhook (interactive when omitted)",
};
const GROUP_BEHAVIOR: FlagSpec = {
  flags: "--group-behavior <behavior>",
  description: "Slack/Feishu/Lark groups: context (recommended) or mentions (least privilege)",
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
  kind: "github" | "telegram" | "slack" | "feishu" | "lark",
  summary: string,
  description: string,
  notes?: string,
): CommandSpec => ({
  name: kind,
  summary,
  description,
  args: [DIR_ARG],
  flags:
    kind === "feishu" || kind === "lark"
      ? [INGRESS, GROUP_BEHAVIOR]
      : kind === "slack"
        ? [GROUP_BEHAVIOR, NO_ONBOARD, REPLACE_CONFIG]
        : [],
  examples: [{ cmd: `fastagent add ${kind}` }],
  ...(notes ? { notes } : {}),
  run: async (args, f) =>
    (await import("./commands/add.ts")).runAddChannel(kind, args[0] as string, {
      ingress: f.ingress as string | undefined,
      groupBehavior: f.groupBehavior as string | undefined,
      onboard: f.onboard !== false,
      replaceConfig: f.replaceConfig === true,
    }),
});

const add: CommandSpec = {
  name: "add",
  summary: "connect a channel (github, telegram, slack, feishu, lark) or vendor a skill",
  description:
    "Scaffold channels/<kind>.ts — first-party adapter glue with the policy to edit (github maps " +
    "events in on(); telegram/slack/feishu/lark route in the optional route()) — or vendor an Agent Skills " +
    "skill into skills/<name>/.",
  subcommands: [
    channelSub(
      "github",
      "scaffold the GitHub webhook channel (issues/PRs → agent turns)",
      "Scaffold channels/github.ts — webhook adapter glue that maps repository events (issues, PRs, " +
        "comments) to agent turns in its on() policy.",
    ),
    channelSub(
      "telegram",
      "scaffold the Telegram bot channel (durable turns, live preview)",
      "Scaffold channels/telegram.ts — the Telegram bot channel with durable turns, a live-preview " +
        "message pump, and an optional route() policy.",
    ),
    channelSub(
      "slack",
      "scaffold the Slack Events API channel (files, threads, context, live preview)",
      "Choose group visibility, scaffold channels/slack.ts plus slack-send.ts, create a single-workspace " +
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
        "Context-aware groups (recommended) request admin approval for im:message.group_msg before publish.",
    ),
    channelSub(
      "lark",
      "scaffold the Lark (international) channel with guided credential setup",
      "Choose WebSocket or webhook, scaffold channels/lark.ts, and guide credential setup against the " +
        "international developer console.",
      "Lark international (open.larksuite.com) is Feishu's compatibility profile. WebSocket stops after " +
        "App ID/Secret validation; webhook and recommended context-aware group setup probe config " +
        "automation and fall back to explicit manual steps on the international config-route 404.",
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
        DIR_ARG,
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
    "(autostop=suspend, state→volume). railway: railway.json (healthcheck /health); its " +
    "volume/variables/App-Sleeping are dashboard/CLI steps the runbook states. agentcore: one " +
    "CloudFormation stack (AWS Bedrock AgentCore Runtime + forwarder Lambda for webhooks + " +
    "EventBridge rules for schedules; linux/arm64 image built locally). Durable ingress " +
    "remains operator-owned (agentcore's forwarder URL is the exception — the stack owns it).",
  args: [{ name: "<host>", description: "deploy target", choices: [...DEPLOY_HOSTS] }, DIR_ARG],
  flags: [
    {
      flags: "--run",
      description:
        "drive the target CLI to completion. Docker runs `docker compose up -d --build`; with a tunnel " +
        "service, reads its URL and registers webhooks. Fly/Railway provision app/service + volume + " +
        "secrets + deploy + webhook setup. AgentCore builds/pushes the arm64 image and deploys the " +
        "stack (aws + docker CLIs). Carries your local credential (env key or OAuth auth.json). " +
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
    "--force). A routine redeploy of an already-provisioned agent is just the host's own command " +
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

const routine: CommandSpec = {
  name: "routine",
  summary: "run and inspect the units of work this definition declares: run now, fire history, what exists",
  subcommands: [
    {
      name: "run",
      summary: "run ONE routine's turn immediately, without waiting for a clock",
      description:
        "Run ONE routine's turn immediately (authoring loop, like invoke) — runs routines/<name>.ts now, " +
        "whether or not it declares a cron. Reply→stdout; does NOT advance its fire state.",
      args: [{ name: "<name>", description: "the routine name (routines/<name>.ts)" }, DIR_ARG],
      flags: [MODEL, NO_INPUT],
      examples: [{ cmd: "fastagent routine run daily-digest" }],
      run: async (args, f) =>
        (await import("./commands/routine-run.ts")).runRoutine(args[0] as string, args[1] as string, {
          model: f.model as string | undefined,
          input: f.input !== false,
        }),
    },
    {
      name: "history",
      summary: "print the recent fires of a routine",
      description:
        "Print a routine's recent fires: when each fired, completed/failed/skipped/interrupted, and how long it " +
        'took — the answer to "did last night\'s run silently fail?". What the run SAID is in its session, a ' +
        "JSON-lines journal under the state root's sessions/ — which this command points at. Read-only.",
      args: [{ name: "<name>", description: "the routine name" }, DIR_ARG],
      flags: [{ flags: "--json", description: "the full records" }],
      examples: [{ cmd: "fastagent routine history daily-digest" }],
      run: async (args, flags) =>
        (await import("./commands/routine.ts")).runRoutineHistory(
          args[0] as string,
          args[1] as string,
          flags.json === true,
        ),
    },
    {
      name: "list",
      summary: "every declared routine, and when (or whether) a clock fires it",
      description:
        "List the routines this definition declares: the next cron instant for each that has one, and " +
        '"on demand" for each that does not — those are reached by name (POST /run, `routine run`). The agent\'s ' +
        "own pending wake-ups are listed too, prefixed `wake`: a different owner (the STATE, not the " +
        "definition), and only the agent cancels them (the `unwake` tool). Read-only.",
      args: [DIR_ARG],
      flags: [JSON_FLAG],
      examples: [{ cmd: "fastagent routine list" }],
      run: async (args, flags) =>
        (await import("./commands/routine.ts")).runRoutineList(args[0] as string, flags.json === true),
    },
  ],
};

const destroy: CommandSpec = {
  name: "destroy",
  summary: "delete every AWS resource `deploy agentcore` created for a workspace",
  description:
    "AgentCore only, and it exists because `aws cloudformation delete-stack` is not enough: the S3 " +
    "artifact bucket and the ECR repository have to exist BEFORE the stack that reads from them, BOTH " +
    "log groups (the forwarder's and the runtime's own stdout) are created by AWS on first write so no " +
    "template mentions them, and a wake alarm is minted at runtime by the container — a schedule that " +
    "keeps retrying into a deleted Lambda. " +
    "Derives the same names from dir that deploy did. Without --run it deletes nothing and reports what " +
    "is out there.",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, DIR_ARG],
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
    "Find the CloudWatch log group for the AgentCore stack derived from dir, then run aws logs tail. " +
    "The default Runtime source shows the agent process's own stdout/stderr; the forwarder source shows " +
    "the Lambda ingress transport logs.",
  args: [{ name: "<host>", description: "deployed host", choices: ["agentcore"] }, DIR_ARG],
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
    "Read-only. Run it against the same workspace passed to deploy so it derives the same CloudFormation " +
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
    "what that provider supports, asked only when both. An agent READS the global store for any provider " +
    "its own file does not have, so `-g` logs in once for every agent on this machine.",
  args: [{ name: "[provider]", description: "provider id (skip the provider menu)" }],
  flags: [
    {
      flags: "-g, --global",
      description: `store in ~/.fastagent/.secrets/auth.json — every agent here reads it for providers its own file lacks`,
    },
    NO_INPUT,
  ],
  examples: [{ cmd: "fastagent login" }, { cmd: "fastagent login openai" }, { cmd: "fastagent login openai -g" }],
  notes: "The positional is the PROVIDER (not a dir) — `cd` into your agent before logging in.",
  run: async (args, f) =>
    (await import("./commands/login.ts")).runLogin(args[0], {
      global: f.global === true,
      input: f.input !== false,
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
  tool,
  invoke,
  routine,
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
