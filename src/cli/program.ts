/**
 * The fastagent command registry: every command as data ({@link CommandSpec}) with a lazy-imported
 * implementation, so `fastagent <cmd>` pays only for the module graph that command actually uses.
 * This file is the CLI surface's single source of truth — the overview and every per-command help
 * render from these specs (no hand-maintained usage text).
 */
import { fastagentVersion } from "../version.ts";
import { buildProgram, type CommandSpec, type FlagSpec, type ProgramOptions } from "./kernel.ts";

// Help groups (clig: most common commands first) — the authoring loop leads, operations close.

// Shared flags — same name, same meaning, on every command that supports them (clig: consistency).
const DIR_ARG = { name: "[dir]", description: "workspace directory", default: "." };
const MODEL: FlagSpec = {
  flags: "--model <provider/modelId>",
  description: "model override (precedence: --model > FASTAGENT_MODEL > config)",
};
const AUTH_PATH: FlagSpec = {
  flags: "--auth-path <file>",
  description: "credentials file (default: <state root>/auth.json; env: FASTAGENT_AUTH_PATH)",
};
const JSON_FLAG: FlagSpec = { flags: "--json", description: "machine-readable JSON output" };
const NO_INPUT: FlagSpec = {
  flags: "--no-input",
  description: "never prompt (CI/scripts) — missing information becomes an error instead of a question",
};
const PORT: FlagSpec = { flags: "--port <n>", description: "HTTP port" };
const TUNNEL: FlagSpec = {
  flags: "--tunnel",
  description:
    "expose a public HTTPS URL via a Cloudflare quick tunnel (needs cloudflared) and auto-register " +
    "webhook channels (telegram, feishu, lark; github prints the URL) — for hosting a bot from your " +
    "own box without deploying (the quick-tunnel URL is ephemeral, not for production)",
};

const init: CommandSpec = {
  name: "init",
  summary: "scaffold a runnable agent and install its dependencies",
  description:
    "Scaffold a runnable agent in dir (default .) and run npm install. Default is a self-iterating " +
    "agent: persona.md (its identity), a writing-great-skills example skill, a fetch-url code tool, " +
    "config, package.json, .gitignore. Never overwrites existing files; an existing AGENTS.md is kept " +
    "as project context.",
  args: [DIR_ARG],
  flags: [
    { flags: "--minimal", description: "persona.md + the example skill + config only (no code tool / package.json)" },
    { flags: "--no-install", description: "scaffold everything but skip npm install" },
    { flags: "--flat", description: "force the flat layout (skip host-signal detection)", conflicts: ["agentDir"] },
    { flags: "--agent-dir <name>", description: "force the agent kit into ./<name>" },
  ],
  examples: [
    { cmd: "fastagent init my-agent", note: "a new agent dir, ready to dev" },
    { cmd: "fastagent init", note: "initialize the current directory" },
  ],
  notes:
    'Layout: flat by default ("a directory is an agent"); when an existing toolchain/deploy claims ' +
    "the directory (tsconfig/framework config, a non-JS build manifest like " +
    "go.mod/pyproject.toml/Cargo.toml, Dockerfile/fly/railway, or occupied tools/, channels/, or " +
    "skills/), the kit goes into ./agent and config.agentDir points there — the reason is printed, " +
    "no prompt.",
  run: async (args, f) =>
    (await import("./commands/init.ts")).runInit(args[0] as string, {
      minimal: f.minimal === true,
      install: f.install !== false,
      flat: f.flat === true,
      agentDir: f.agentDir as string | undefined,
    }),
};

const dev: CommandSpec = {
  name: "dev",
  summary: "serve the agent locally, restarting on code edits",
  description:
    "Assemble the agent in dir (default .) and serve a local HTTP channel. persona.md/AGENTS.md/skills " +
    "are re-read every turn (edits go live next turn); edits to code inputs — tools/, channels/, " +
    "fastagent.config.*, package.json, .env — restart the worker. Files the agent writes as work " +
    "product never trigger a restart.",
  args: [DIR_ARG],
  flags: [
    PORT,
    MODEL,
    AUTH_PATH,
    { flags: "--no-watch", description: "serve once, no file-watching" },
    TUNNEL,
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent dev" },
    { cmd: "fastagent dev --tunnel", note: "public URL + auto-registered webhooks" },
  ],
  run: async (args, f) =>
    (await import("./commands/dev.ts")).runDev(args[0] as string, {
      port: f.port as string | undefined,
      model: f.model as string | undefined,
      authPath: f.authPath as string | undefined,
      watch: f.watch !== false,
      tunnel: f.tunnel === true,
      input: f.input !== false,
    }),
};

const attach: CommandSpec = {
  name: "attach",
  summary: "watch a session's live events from a running serve and steer it",
  description:
    "Attach to a session served by a running dev/start with `sessionControl: true` in the config: " +
    "stream its live events (text, tools, run boundaries), steer the active run by typing — or, with " +
    "no run active, start one (detaching cancels a run YOU started) — /abort to stop a run. Discovers " +
    "the local endpoint from <stateRoot>/control.json; --url/--token reach a remote serve. The same " +
    "wire protocol a Web panel or desktop app uses.",
  args: [{ name: "<session>", description: "the session id to attach to" }, DIR_ARG],
  flags: [
    { flags: "--url <url>", description: "control endpoint (skip control.json discovery)" },
    { flags: "--token <token>", description: "bearer token for --url" },
  ],
  examples: [{ cmd: "fastagent attach tg-chat-42" }],
  run: async (args, f) =>
    (await import("./commands/attach.ts")).runAttach(args[0] as string, args[1] as string | undefined, {
      url: f.url as string | undefined,
      token: f.token as string | undefined,
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
  flags: [MODEL, AUTH_PATH],
  examples: [{ cmd: "fastagent chat" }],
  run: async (args, f) =>
    (await import("./commands/chat.ts")).runChat(args[0] as string, {
      model: f.model as string | undefined,
      authPath: f.authPath as string | undefined,
    }),
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
  flags: [JSON_FLAG, MODEL, AUTH_PATH, { flags: "--sessions-dir <dir>", description: "sessions directory override" }],
  examples: [{ cmd: "fastagent info" }, { cmd: "fastagent info --json", note: "for CI" }],
  run: async (args, f) =>
    (await import("./commands/info.ts")).runInfo(args[0] as string, {
      json: f.json === true,
      model: f.model as string | undefined,
      authPath: f.authPath as string | undefined,
      sessionsDir: f.sessionsDir as string | undefined,
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
    "Mounts the same tool set dev/start serve (defaults + config.tools + discovered tools/, " +
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
  flags: [MODEL, AUTH_PATH, NO_INPUT],
  examples: [{ cmd: `fastagent invoke "summarize today's inbox"` }],
  run: async (args, f) =>
    (await import("./commands/invoke.ts")).runInvoke(args[0] as string, args[1] as string, {
      model: f.model as string | undefined,
      authPath: f.authPath as string | undefined,
      input: f.input !== false,
    }),
};

const fire: CommandSpec = {
  name: "fire",
  summary: "run ONE schedule's turn immediately, without waiting for its cron",
  description:
    "Run ONE schedule's turn immediately (authoring loop, like invoke) — fires schedules/<name>.ts now " +
    "without waiting for its cron. Reply→stdout; does NOT advance the schedule's fire state.",
  args: [{ name: "<name>", description: "the schedule name (schedules/<name>.ts)" }, DIR_ARG],
  flags: [MODEL, AUTH_PATH, NO_INPUT],
  examples: [{ cmd: "fastagent fire daily-digest" }],
  run: async (args, f) =>
    (await import("./commands/fire.ts")).runFire(args[0] as string, args[1] as string, {
      model: f.model as string | undefined,
      authPath: f.authPath as string | undefined,
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
  flags: [
    PORT,
    MODEL,
    { flags: "--sessions-dir <dir>", description: "sessions directory override" },
    AUTH_PATH,
    TUNNEL,
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent start" },
    { cmd: "fastagent start --tunnel", note: "host a bot from your own box, no deploy" },
  ],
  notes:
    "Precedence chains:\n" +
    "  port:     --port > PORT env > fastagent.config.ts http.port > 8787\n" +
    "  state:    FASTAGENT_STATE_DIR > <dir>/.fastagent — the ONE machine-state\n" +
    "            root (auth, sessions, channel state all derive from it); point\n" +
    "            it at a mounted volume so a redeploy that replaces the\n" +
    "            directory never wipes state\n" +
    "  sessions: --sessions-dir > FASTAGENT_SESSIONS_DIR > <state>/sessions\n" +
    "  auth:     --auth-path > FASTAGENT_AUTH_PATH > <state>/auth.json\n" +
    "            (project-level; point it at ~/.fastagent/auth.json to share one\n" +
    "            credential across projects)",
  run: async (args, f) =>
    (await import("./commands/start.ts")).runStart(args[0] as string, {
      port: f.port as string | undefined,
      model: f.model as string | undefined,
      sessionsDir: f.sessionsDir as string | undefined,
      authPath: f.authPath as string | undefined,
      tunnel: f.tunnel === true,
      input: f.input !== false,
    }),
};

/** The retired app-creation flag — parsed so it can explain itself, hidden from help. */
const CREATE_APP: FlagSpec = { flags: "--create-app", description: "(retired)", hidden: true };

const channelSub = (
  kind: "github" | "telegram" | "feishu" | "lark",
  summary: string,
  description: string,
  notes?: string,
): CommandSpec => ({
  name: kind,
  summary,
  description,
  args: [DIR_ARG],
  flags: [CREATE_APP],
  examples: [{ cmd: `fastagent add ${kind}` }],
  ...(notes ? { notes } : {}),
  run: async (args, f) =>
    (await import("./commands/add.ts")).runAddChannel(kind, args[0] as string, { createApp: f.createApp === true }),
});

const add: CommandSpec = {
  name: "add",
  summary: "connect a channel (github, telegram, feishu, lark) or vendor a skill",
  description:
    "Scaffold channels/<kind>.ts — third-party adapter glue with the policy to edit (github maps " +
    "events in on(); telegram/feishu/lark route in the optional route()) — or vendor an Agent Skills " +
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
      "feishu",
      "scaffold the Feishu channel AND create/configure the platform app",
      "Scaffold channels/feishu.ts AND create/configure the Feishu platform app (scan-to-create), " +
        "writing credentials to .env.",
      "Feishu (open.feishu.cn) is the canonical implementation. `add feishu` also CREATES + " +
        'configures the platform app (confirm a link in the app — the platform\'s "scan to create" ' +
        "flow; one version-publish action remains) and writes credentials to .env; a persisted " +
        "ID/Secret pair resumes missing-Token setup instead of creating another app.",
    ),
    channelSub(
      "lark",
      "scaffold the Lark (international) channel with guided credential setup",
      "Scaffold channels/lark.ts — the Lark international profile over the Feishu engine — and guide " +
        "credential setup against the intl developer console.",
      "Lark international (open.larksuite.com) is Feishu's compatibility profile with degraded " +
        "control-plane setup: opens the intl developer console only for a new/partial pair, validates " +
        "App ID/Secret, then probes webhook-mode + Token automation; an explicit config-route 404 " +
        "falls back to a hidden Token prompt + manual mode/URL setup.",
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
  summary: "generate deploy artifacts + a runbook for docker, fly, or railway (--run drives it)",
  description:
    "Generate Dockerfile/.dockerignore plus the target config and print an ordered runbook. " +
    "docker: fastagent.compose.yml, loopback port, persistent state volume. fly: fly.toml " +
    "(autostop=suspend, state→volume). railway: railway.json (healthcheck /health); its " +
    "volume/variables/App-Sleeping are dashboard/CLI steps the runbook states. Durable ingress " +
    "remains operator-owned.",
  args: [{ name: "<host>", description: "deploy target", choices: ["docker", "fly", "railway"] }, DIR_ARG],
  flags: [
    {
      flags: "--run",
      description:
        "drive the target CLI to completion. Docker runs `docker compose up -d --build`; with a tunnel " +
        "service, reads its URL and registers webhooks. Fly/Railway provision app/service + volume + " +
        "secrets + deploy + webhook setup. Carries your local credential (env key or OAuth auth.json). " +
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
      flags: "--stop",
      description: "(fly only) autostop by stopping (cold start) instead of suspending (fast resume)",
    },
    {
      flags: "--no-scale-to-zero",
      description: "(fly only) keep one machine running when idle (min_machines_running=1)",
    },
    {
      flags: "--into-linked",
      description:
        "(railway --run) provision INTO the project this dir is already linked to (skip create); by " +
        "default --run refuses a pre-existing link (could be unrelated/production)",
    },
    MODEL,
    AUTH_PATH,
    NO_INPUT,
  ],
  examples: [
    { cmd: "fastagent deploy fly --run", note: "provision + deploy + webhooks" },
    { cmd: "fastagent deploy docker --tunnel --run", note: "Compose + a public URL" },
    { cmd: "fastagent deploy railway", note: "print the runbook only" },
  ],
  notes:
    "Definition-read-only: the only writes are generated artifacts (never clobbered without " +
    "--force). A routine redeploy of an already-provisioned agent is just the host's own command " +
    "(e.g. `railway up`).",
  run: async (args, f) =>
    (await import("./commands/deploy.ts")).runDeploy(args[0] as "docker" | "fly" | "railway", args[1] as string, {
      run: f.run === true,
      tunnel: f.tunnel === true,
      force: f.force === true,
      stop: f.stop === true,
      scaleToZero: f.scaleToZero !== false,
      intoLinked: f.intoLinked === true,
      model: f.model as string | undefined,
      authPath: f.authPath as string | undefined,
      input: f.input !== false,
    }),
};

const schedule: CommandSpec = {
  name: "schedule",
  summary: "inspect and control time triggers: run audit, pending fires, cancel a wake-up",
  subcommands: [
    {
      name: "history",
      summary: 'print the run audit for a schedule (or "wake" for self-scheduled wake-ups)',
      description:
        "Print the run audit for a schedule: when each run fired, completed/failed/deferred, duration, and " +
        'the reply/error — the answer to "did last night\'s run silently fail?". Read-only.',
      args: [
        { name: "<name>", description: 'the schedule name, or "wake" for the agent\'s self-scheduled wake-ups' },
        DIR_ARG,
      ],
      flags: [{ flags: "--json", description: "the full records (complete reply text)" }],
      examples: [
        { cmd: "fastagent schedule history daily-digest" },
        { cmd: "fastagent schedule history wake --json", note: "the agent's own wake-ups" },
      ],
      run: async (args, flags) =>
        (await import("./commands/schedule.ts")).runScheduleHistory(
          args[0] as string,
          args[1] as string,
          flags.json === true,
        ),
    },
    {
      name: "list",
      summary: "everything that will fire: static schedules (next instant) + pending wake-ups",
      description:
        "List everything that will fire, from BOTH producers: the static schedules/ files (name + next " +
        "cron instant) and the agent's pending self-scheduled wake-ups. Read-only.",
      args: [DIR_ARG],
      flags: [JSON_FLAG],
      examples: [{ cmd: "fastagent schedule list" }],
      run: async (args, flags) =>
        (await import("./commands/schedule.ts")).runScheduleList(args[0] as string, flags.json === true),
    },
    {
      name: "cancel",
      summary: "remove a pending wake-up — the operator's kill switch for a runaway recurring wake",
      description:
        "Remove a pending wake-up — the operator's kill switch for a runaway recurring wake (the agent's own " +
        "is the `unwake` tool). Not session-scoped: the operator owns the box.",
      args: [{ name: "<id>", description: "the wake-up id (`fastagent schedule list` shows ids)" }, DIR_ARG],
      examples: [{ cmd: "fastagent schedule cancel wake-1700000000000-ab12" }],
      run: async (args) =>
        (await import("./commands/schedule.ts")).runScheduleCancel(args[0] as string, args[1] as string),
    },
  ],
};

const login: CommandSpec = {
  name: "login",
  summary: "authenticate a model provider (subscription/OAuth or API key)",
  description:
    "Authenticate a model provider into the project-level <state root>/auth.json — default " +
    "<cwd>/.fastagent/auth.json (run from $HOME for the global ~/.fastagent/auth.json): pick a method " +
    "(subscription/OAuth or API key), then a provider that offers it (configured status shown). " +
    "[provider] takes the method from what that provider supports, asked only when both.",
  args: [{ name: "[provider]", description: "provider id (skip the provider menu)" }],
  flags: [AUTH_PATH, NO_INPUT],
  examples: [{ cmd: "fastagent login" }, { cmd: "fastagent login openai" }],
  notes: "The positional is the PROVIDER (not a dir) — `cd` into your agent before logging in.",
  run: async (args, f) =>
    (await import("./commands/login.ts")).runLogin(args[0], {
      authPath: f.authPath as string | undefined,
      input: f.input !== false,
    }),
};

/** Registration order = help order — the ORIGINAL usage wall's order, kept verbatim (this is a
 *  commander refactor of the same CLI, not a redesign). Exported for the kernel conformance tests. */
export const specs: readonly CommandSpec[] = [
  init,
  models,
  info,
  tool,
  invoke,
  fire,
  schedule,
  dev,
  chat,
  attach,
  start,
  add,
  deploy,
  login,
];

/**
 * The production program assembly (specs + the top-level examples/docs). Tests build through THIS —
 * with their IO/width/color seams as overrides — so they exercise the real shape, not a lookalike.
 */
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

/** Parse and run one CLI invocation (`argv` = process.argv). Usage errors exit 2 via the kernel policy. */
export async function runCli(argv: readonly string[]): Promise<void> {
  await buildCliProgram({ version: await fastagentVersion() }).parseAsync([...argv]);
}
