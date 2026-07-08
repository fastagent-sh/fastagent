# FastAgent AI-guided start

Use this prompt with Claude Code, Codex, pi, or another coding agent when you want help creating or wiring a FastAgent workspace.

```txt
You are helping me use FastAgent.

Goal: turn an existing agent directory into a deployable agent without rewriting it.

FastAgent mental model:
- The directory is the agent: persona.md (its identity) + skills/ + optional tools/ + optional
  channels/. An AGENTS.md is PROJECT CONTEXT the agent reads (its own, or a host repo's) — having an
  AGENTS.md does not make a directory a fastagent workspace; a fastagent.config.* does.
- FastAgent can run it locally, embed it in my app, connect it to channels like GitHub and Telegram, or deploy it to a host.
- Do not invent a new framework layout unless I ask. Prefer the existing directory.

How you run FastAgent commands (you are a non-interactive agent, so this matters):
- A model must be set EXPLICITLY. With no model, `dev`/`start`/`invoke` fall back to an interactive
  picker you cannot answer, and fail with `missing model`. So: run `fastagent login` (ask me which
  provider first), list specs with `fastagent models`, then ALWAYS pass `--model provider/id` (or set
  FASTAGENT_MODEL, or write `model:` into fastagent.config.*). Never rely on the interactive prompt.
- Some commands EXIT, others BLOCK. `info`, `models`, `invoke`, `tool` return — use these for checks
  and smoke tests. `dev` and `start` are long-running servers: do NOT run them in the foreground (you
  will hang waiting) — background them, or let me run them.
- Secrets live in `.env` (copy from `.env.example`) or come from `fastagent login`. Ask me before
  adding one; never commit `.env`, credentials, sessions, or `.fastagent/` machine state.

First inspect my project:
1. Check whether fastagent.config.* exists (= already a workspace; read its agentDir if set).
2. Check whether persona.md, AGENTS.md, skills/, tools/, channels/ exist — at the root, or under agentDir.
3. Check package.json for "type": "module" if code tools are present.
4. Ask before choosing a model provider or adding secrets.

Set up (run init ONCE per directory — it refuses an already-initialized workspace):
- Run: fastagent init <dir> (default: current dir). It scaffolds persona.md (the agent's identity),
  an example skill and tool, and config; it never clobbers existing files, keeps an existing AGENTS.md
  as project context, and refuses a dir that already has a fastagent.config.* (already a workspace).
- Layout is decided automatically: flat by default; if an existing toolchain/deploy claims the dir
  (tsconfig/framework config, a non-JS build manifest like go.mod/pyproject.toml/Cargo.toml,
  Dockerfile/fly/railway, occupied tools//channels//skills/), the kit goes
  into ./agent with config.agentDir pointing there — init prints the reason. Override on the FIRST
  run: --flat / --agent-dir <name> (a re-run is refused once the config exists). To change the layout
  afterwards: move the kit files yourself and update (or remove) config.agentDir to match.
- Then run: fastagent info (read-only) — it shows what the directory assembles into (model, persona,
  context, skills, tools, channels). Fix only what it reports.

For local testing (prefer commands that exit):
- Smoke-test one turn: fastagent invoke "hello" --model provider/id
- Test one tool without a model: fastagent tool <name> '<json>'
- Only if I want a live server: fastagent dev --model provider/id (long-running — background it or let
  me run it), then send a turn to POST /invoke.

For tools:
- Put tools in tools/<name>.ts.
- Use defineTool and z from @kid7st/fastagent.
- Test with: fastagent tool <name> '<json>'

For GitHub:
- Run: fastagent add github
- Edit channels/github.ts so on(event) maps real GitHub events to { session, text } intents.
- Use fastagent dev --tunnel for local webhook testing.

For Telegram:
- Run: fastagent add telegram
- Set TELEGRAM_BOT_TOKEN and TELEGRAM_SECRET_TOKEN.
- Use fastagent dev --tunnel for local webhook testing.

For schedules (run the agent on a cron — daily digest, periodic checks):
- Create schedules/<name>.ts: export default defineSchedule({ cron: "0 9 * * *", tz: "America/New_York",
  prompt: "..." }) — defineSchedule comes from @kid7st/fastagent; the filename is the schedule name.
- The prompt must SAY where output goes ("…and send it to the team Telegram"): the scheduler only fires
  the agent — a scheduled turn's plain reply is not delivered anywhere; delivery is a send tool's job.
- Test with a command that exits: fastagent fire <name> --model provider/id (runs the turn NOW, without
  touching the real cron state). The cron only fires while `dev`/`start` is serving.
- Check past runs with: fastagent schedule history <name>; see what will fire with: fastagent schedule list.
- Self-scheduling (the agent sets its own follow-ups via a built-in `wake` tool) is opt-in:
  selfSchedule: true in fastagent.config.*.
- Deploying with schedules or selfSchedule keeps one machine always running (no scale-to-zero — a
  sleeping box misses the instant); `fastagent deploy` handles this, don't fight it.

For embedding:
- Use createPiAgentFromDefinition or createPiAgentFromWorkspace.
- Mount createInvokeHandler(agent) in my app route.
- Keep my app's auth/database/session ownership in my app.

For deploy:
- Run: fastagent deploy fly (or: fastagent deploy railway). Add --run to drive the host CLI to
  completion; without it, follow the printed runbook.
- The model MUST be in fastagent.config.* — a --model/FASTAGENT_MODEL/.env value is builder-local and
  won't reach the deployed box (it would crash-loop with `missing model`).
- Declare any extra host secrets in config.deploy.secrets; register channel webhooks at the live URL.

Before finishing:
- Run fastagent info.
- Run the smallest useful smoke test that EXITS: fastagent invoke "hello" --model provider/id (or a
  channel-specific local test). Do not leave `dev`/`start` running in the foreground.
- Do not commit .env, credentials, sessions, or .fastagent machine state.
- If a command fails, read docs/troubleshooting.md before guessing.
```

References:

- [Quickstart](quickstart.md)
- [Configuration](configuration.md)
- [Embedding](embedding.md)
- [Channels](channels.md)
- [Deploy](deploy.md)
- [Troubleshooting](troubleshooting.md)
