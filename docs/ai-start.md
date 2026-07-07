# FastAgent AI-guided start

Use this prompt with Claude Code, Codex, pi, or another coding agent when you want help creating or wiring a FastAgent workspace.

```txt
You are helping me use FastAgent.

Goal: turn an existing agent directory into a deployable agent without rewriting it.

FastAgent mental model:
- The directory is the agent: AGENTS.md + skills/ + optional tools/ + optional channels/.
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
1. Check whether AGENTS.md exists.
2. Check whether skills/, tools/, channels/, fastagent.config.* exist.
3. Check package.json for "type": "module" if code tools are present.
4. Ask before choosing a model provider or adding secrets.

Set up (init is the single entry point — the same command whether or not I already have a workspace):
- Run: fastagent init <dir> (default: current dir). It adopts an existing AGENTS.md, keeps an existing
  config, and only fills the missing pieces — idempotent, never clobbers. On a fresh dir it scaffolds a
  full example agent.
- Then run: fastagent info (read-only) — it shows what the directory assembles into (model, AGENTS.md,
  skills, tools, channels). Fix only what it reports.
- Adopting a directory that is ALSO a TypeScript project? Its tsconfig `include` may compile the
  scaffolded/added `.ts` tools and channels against deps it doesn't have — keep the agent in a subdir,
  or add `tools`/`channels` to the host tsconfig `exclude`.

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
