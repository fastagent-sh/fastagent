---
title: CLI reference
description: "The fastagent CLI reference: init, info, dev, chat, invoke, tool, start, login, models, add, fire, schedule, and deploy commands with flags."
status: current
---

# CLI reference

The `fastagent` CLI is the standalone workflow for creating, inspecting, serving, and operating an agent workspace.

```bash
fastagent <command> [args] [options]
```

Most commands take an optional workspace directory. When omitted, the current directory is used.

## Commands

| Command | Purpose |
|---|---|
| `init [dir]` | Scaffold a runnable agent workspace. |
| `info [dir]` | Inspect what a workspace assembles into without serving. |
| `models [search]` | List model specs. |
| `login [provider]` | Store provider credentials in the project-level `<state root>/auth.json` (default `<cwd>/.fastagent/auth.json`; override: `--auth-path` / `FASTAGENT_AUTH_PATH`, root: `FASTAGENT_STATE_DIR`). |
| `dev [dir]` | Serve locally with watch/reload. |
| `chat [dir]` | Open the same assembled agent in pi's interactive TUI. |
| `invoke <message> [dir]` | Run one agent turn and exit. |
| `fire <name> [dir]` | Run one schedule's turn immediately (authoring loop). |
| `schedule history <name> [dir]` | Print the run audit for a schedule (or `wake`). |
| `schedule list [dir] [--json]` | Everything that will fire: static schedules (next instant) + pending wake-ups. |
| `schedule cancel <id> [dir]` | Remove a pending wake-up (operator kill switch). |
| `tool <name> <json> [dir]` | Run one discovered tool directly. |
| `add github|telegram|slack|feishu|lark [dir]` | Scaffold a first-party channel. `add slack` creates a single-workspace internal app through the Manifest API + OAuth (or `--no-onboard`), with context-aware or mention-only policy. `add feishu` scan-creates/configures the canonical app and resumes partial state. `add lark` guides/validates international credentials and falls back on its known config-route gap. |
| `add skill <source> [dir]` | Vendor an Agent Skills skill into `skills/`. |
| `deploy docker [dir]` | Generate `fastagent.compose.yml` + the portable `Dockerfile`/`.dockerignore` for local Docker: one `agent` service, loopback port, `/data` state volume, and exact env-var names. `--tunnel --run` starts app+tunnel, reads the ephemeral URL, and auto-registers Telegram, locally onboarded Slack, and Feishu/Lark webhooks. Existing files stay authoritative unless `--force`; durable ingress/proxy/DNS/TLS remain operator-owned. |
| `deploy fly [dir]` | Generate Fly.io artifacts (`fly.toml`/`Dockerfile`/`.dockerignore`, autostop=suspend, state→volume) and print a flyctl runbook + webhook step. `--run` drives flyctl to completion (idempotent, resumable; carries your local credential; needs flyctl). `--stop` (stop instead of suspend), `--no-scale-to-zero` (keep one machine up), `--force` (overwrite artifacts). |
| `deploy railway [dir]` | Generate Railway artifacts (`railway.json` with `healthcheckPath=/health`, plus the shared `Dockerfile`/`.dockerignore`) and print a `railway` runbook: init a project, create a service (`railway add --service`), attach a `/data` volume, set the state root + secrets as variables (`railway variables set`, before the first deploy), `railway up`, then mint a domain (`railway domain`) and register the webhook. Scale-to-zero (App Sleeping) is a dashboard-only step the runbook states. `--run` drives the railway CLI to completion on an UNLINKED dir (auth → init/add/volume → variables → `railway up` → mint domain → telegram webhook; carries your local credential; needs the railway CLI); a dir already linked to a project is refused unless `--into-linked` (provision into it) — a routine redeploy is just `railway up`. `--force` overwrites artifacts. |
| `start [dir]` | Serve without watch. |

## `fastagent init`

```bash
fastagent init [dir] [--minimal] [--no-install] [--flat] [--agent-dir <name>]
```

Creates a self-iterating agent — the directory is the agent, and it can edit its own definition (persona.md and skills are re-read every turn). A fresh workspace has `persona.md` (the agent's identity: how to improve yourself), a `writing-great-skills` example skill (from [mattpocock/skills](https://github.com/mattpocock/skills) — the guide to authoring skills), a `fetch-url` example code tool, config, `.env.example`, and `.gitignore`. No `AGENTS.md` is scaffolded (it is project context, not identity); an existing one is kept untouched. Everything is written offline; by default it also writes `package.json` and runs `npm install`. Ignore files follow the layout: flat workspaces use the root `.gitignore` for `.env`, `.fastagent`, and `node_modules/`; `--agent-dir` workspaces keep root state/secrets in the root `.gitignore` and kit dependencies in `<agentDir>/.gitignore`.

**Layout** — flat by default ("a directory is an agent"). When an existing system already claims the directory — a toolchain/build manifest (`tsconfig.json`, `next|vite|astro|svelte|nuxt|remix|webpack|rollup.config.*`, or a non-JS ecosystem's — `go.mod`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `requirements.txt`, `Gemfile`, `pom.xml`, `build.gradle`, `composer.json`, `CMakeLists.txt`), a deploy manifest (`Dockerfile`, `fly.toml`, `railway.toml`, `vercel.json`, `netlify.toml`), or occupied `tools/`, `channels/`, or `skills/` — the agent kit goes into `./agent` with `config.agentDir` pointing there, and the reason is printed (no prompt). The agent kit self-contains its `package.json`, so a host repo's manifest and lockfile are never touched. `init` never overwrites existing files and refuses only a directory that already has a `fastagent.config.*`.

Options:

| Option | Meaning |
|---|---|
| `--minimal` | persona.md + the example skill + config only — no code tool, package.json, or install. |
| `--no-install` | Scaffold everything but skip `npm install`. |
| `--flat` | Force the flat layout (skip the jurisdiction detection). |
| `--agent-dir <name>` | Force the agent kit into `./<name>`. |

## `fastagent info`

```bash
fastagent info [dir] [--json] [--model provider/modelId] [--auth-path file] [--sessions-dir dir]
```

Prints the assembled surface without starting a server:

- model source,
- config path,
- persona presence and context files (`AGENTS.md`),
- skills and diagnostics,
- non-default tools and collisions,
- channel files,
- schedules (name + next fire instant; a broken schedule file is reported here, not first at `dev`),
- whether self-scheduling (`selfSchedule`) is on,
- session directory.

`info` is read-only: it does not create sessions or modify `.fastagent/`.

## `fastagent models`

```bash
fastagent models [search]
```

Lists available model specs in `provider/modelId` form. Pass a search string to filter.

Use a listed spec with `--model`, `FASTAGENT_MODEL`, or `fastagent.config.*`.

## `fastagent login`

```bash
fastagent login [provider] [--auth-path file] [--no-input]
```

Authenticates a model provider and stores credentials in the **project-level** `<state root>/auth.json` — by default `<cwd>/.fastagent/auth.json` (root override: `FASTAGENT_STATE_DIR`; file override: `--auth-path` / `FASTAGENT_AUTH_PATH`; run it from `$HOME` to write the global `~/.fastagent/auth.json`). There is no implicit fallback between the project and global files — the default is project-level for **isolation** (different agents can use different accounts) and **fail-visibly** (a missing credential surfaces instead of being masked by a machine-global one absent on a fresh box). So `cd` into your agent before logging in. FastAgent uses its own credential file, separate from pi's CLI state.

An API-key login is verified immediately with one minimal request (OAuth needs no check — completing
the flow proves the credential): a definitive rejection (HTTP 401) removes the bad key and prompts
for it again on the spot (cancel to stop), so a mistyped key is corrected at login time instead of
failing at the first invoke; an inconclusive failure (network, quota, permissions) keeps the key and
prints the provider's message.

**Running several agents off one account on your dev machine?** Point them all at the one global file: set `FASTAGENT_AUTH_PATH=~/.fastagent/auth.json` (a `.env` entry, a shell env var, or `--auth-path`), or just `login`/run from `$HOME`. A leading `~` is expanded to your home dir in `--auth-path` and `FASTAGENT_AUTH_PATH` (shell variables like `$HOME` are not — use `~` or an absolute path). Sharing **one file** is safe — a single cross-process lock serializes OAuth refresh, so concurrent instances always read the latest token. (What is *not* safe is copying the file around: two files over one grant each rotate the single-use refresh token and break the other.)

## `fastagent dev`

```bash
fastagent dev [dir] [--port N] [--model provider/modelId] [--auth-path file] [--no-watch] [--tunnel] [--no-input]
```

Assembles the workspace and serves it locally. persona.md/AGENTS.md/`skills/` are re-read every turn (edits go
live next turn, no restart); a supervisor restarts the worker on edits to the code inputs —
`tools/`, `channels/`, `fastagent.config.*`, `package.json`, `.env`.

With no model set and a terminal attached, `dev` first shows the full model catalog — models whose
provider already has credentials are listed first and annotated with the source (e.g. `ready —
OPENAI_API_KEY`); picking one that needs auth runs the login flow inline — then writes the choice
back to the config (same for `start` / `invoke` / `fire` / `chat` / `deploy`). Pass `--model` or set
`FASTAGENT_MODEL` to skip the prompt.

Options:

| Option | Meaning |
|---|---|
| `--port N` | Override `http.port` / default `8787`. |
| `--model spec` | Override model selection. |
| `--auth-path file` | Override the credential file (default `<state root>/auth.json`). |
| `--no-watch` | Serve once without the watch supervisor. |
| `--tunnel` | Open a Cloudflare quick tunnel for webhook testing. |
| `--no-input` | Never prompt (CI/scripts) — e.g. the first-run model pick becomes an actionable error instead of a question. |

Model precedence:

```txt
--model > FASTAGENT_MODEL > fastagent.config.* model
```

## `fastagent attach`

```bash
fastagent attach <session> [dir] [--url url --token token]
```

Attach to a session served by a running `dev`/`start` with `sessionControl: true` in the config:
stream its live events (text, tool activity, run boundaries), steer the active run by typing a
line — or, with no run active, start one (the line becomes a new prompt over the remote data
plane) — `/abort` to stop a run, Ctrl+C to detach. A run YOU started from attach is driven by
attach's own connection, so detaching cancels it (channel-started runs are unaffected). Discovers the local endpoint from
`<stateRoot>/control.json`; `--url`/`--token` reach a remote serve. Speaks the same wire protocol a
Web panel or desktop app uses (`connectSessionControl`).

## `fastagent chat`

```bash
fastagent chat [dir] [--model provider/modelId] [--auth-path file]
```

Opens the same assembled workspace in pi's interactive TUI. This is useful for trying the agent before serving it through channels.

Auth is fastagent's, same as every other command: `--auth-path` > `FASTAGENT_AUTH_PATH` > the
workspace `auth.json`. Log in with `fastagent login` (or pi's `/login` inside the TUI, which writes
to the same file). With no model set, `chat` runs the same first-run picker as the serving commands
(credential-annotated catalog, inline login) and writes the choice back to the config.

## `fastagent invoke`

```bash
fastagent invoke <message> [dir] [--model provider/modelId] [--auth-path file] [--no-input]
```

Runs one turn through the same workspace assembly and exits:

- answer text streams to stdout,
- tool and diagnostic lines go to stderr,
- a `failed` terminal event exits non-zero.

Use this for smoke tests and scripts.

## `fastagent fire`

```bash
fastagent fire <name> [dir] [--model provider/modelId] [--auth-path file] [--no-input]
```

Runs ONE schedule's turn immediately — the authoring loop for schedules (like `invoke` is for a
prompt). Fires `schedules/<name>.ts` now, without waiting for its cron, using the schedule's stable
session, so you see exactly what the served scheduler would do:

- answer text streams to stdout, tool/diagnostic lines to stderr, a `failed` turn exits non-zero (like `invoke`),
- no name → usage on stderr, exit 2; an unknown schedule name → exit 1 with the available names,
- it does **not** advance the schedule's fire state — a test run never makes the running scheduler skip the real next run.

A `schedules/<name>.ts` file default-exports `defineSchedule({ cron, tz?, prompt })`; the scheduler
fires the agent on that cron when you `dev`/`start`. Output is the agent's tools' job — the scheduler
only fires and logs. See the [API reference](./api-reference.md#schedule-authoring).

## `fastagent schedule history`

```bash
fastagent schedule history <name> [dir] [--json]
```

Prints the run audit for one schedule — or `wake` for the agent's self-scheduled wake-ups: when each run
fired, its outcome (`completed` / `failed` / `deferred`), duration, and a preview of the reply or error.
The answer to "did last night's run silently fail?". Read-only (reads `<state root>/schedule/runs.jsonl`,
written by the serving scheduler); `--json` prints the full records, including the complete reply text.

`fastagent schedule list [dir]` shows everything that will fire, from BOTH producers: the static
`schedules/` files (name + next cron instant) and the agent's pending self-scheduled wake-ups (id, next
fire, one-shot/cron, session, prompt), with `--json` for the machine-readable form;
`fastagent schedule cancel <id> [dir]` removes one wake-up: the
operator's kill switch for a runaway recurring wake (the agent's own is the `unwake` tool, which is
session-scoped).

## `fastagent tool`

```bash
fastagent tool <name> '<json-args>' [dir]
```

Runs one discovered or configured tool directly, without a model or server. The call receives its
workspace cwd but no session manager; a session-dependent tool reports that requirement itself.

Example:

```bash
fastagent tool fetch-url '{"url":"https://example.com"}'
```

## `fastagent add github|telegram|slack|feishu|lark`

```bash
fastagent add github [dir]
fastagent add telegram [dir]
fastagent add slack [dir]      # create/install an internal app; --no-onboard scaffolds only
fastagent add feishu [dir]   # 飞书 (open.feishu.cn) — also CREATES the app (scan-to-create; credentials → .env)
fastagent add lark [dir]     # Lark intl — opens console + collects/validates credentials
```

Creates a `channels/<kind>.ts` file with adapter glue and appends env placeholders to `.env.example` when possible. When `.env` is gitignored, the channel's GENERATED secrets (telegram's `TELEGRAM_SECRET_TOKEN`, github's `GITHUB_WEBHOOK_SECRET` — random strings the user contributes nothing to) are also written to the run-root `.env`, leaving only genuinely-manual values (e.g. `TELEGRAM_BOT_TOKEN` from BotFather) as next steps. When `config.agentDir` is set, the channel (and any companion tool) lands under that subdirectory — the same place `dev`/`start` discover channels — while `.env.example` and the secret hygiene stay at the run root, where `.env` is read.

An enabled `channels/*.ts|*.js|*.mjs` file must load successfully or `dev` / `start` fails. To
intentionally disable one, rename it to e.g. `channels/telegram.ts.disabled`; channel files, not config,
are the enable/disable source of truth.

Slack scaffolds `channels/slack.ts` plus `tools/slack-send.ts`; `--group-behavior context|mentions`
selects both runtime policy and manifest scopes/events, defaulting to context-aware `context`; choose
`mentions` explicitly for least privilege. By default it opens Slack's App Configuration Token page,
creates a new internal app with `agent_view`, native streams/tasks, and suggested prompts through
`apps.manifest.create`, installs it
through OAuth, and writes rotating bot credentials + the Signing Secret to the gitignored `.env`. The configuration refresh token stays owner-readable
under `<state root>/channels/slack/` and is used locally by `dev --tunnel` / `deploy --run` to update the
Events API URL; it never travels to the host. `--no-onboard` preserves the manual scaffold-only path.
`--replace-config` skips the menu and directly replaces the local App Configuration token pair — the
repair when automatic Request URL updates fail because the tokens expired or were revoked. It works only
on the machine that onboarded the app (the pair lives in its local state); other machines set the Request
URL manually in the Slack console.

See:

- [GitHub channel](github.md)
- [Telegram channel](telegram.md)
- [Slack channel](slack.md)
- [Feishu channel (Lark compatibility)](feishu.md)

## `fastagent add skill`

```bash
fastagent add skill <source> [dir] [--update]
```

Vendors an Agent Skills skill into `skills/<name>/` (under `config.agentDir` when set). Sources can be:

- a GitHub-style ref,
- a local path,
- a bare name from local global skill directories.

Use `--update` to overwrite an existing vendored skill. Review the result with `git diff` before deploying.

## `fastagent start`

```bash
fastagent start [dir] [--port N] [--model provider/modelId] [--sessions-dir dir] [--auth-path file] [--tunnel] [--no-input]
```

Runs the workspace in production posture: no watch, same assembly as `dev`.

Port precedence:

```txt
--port > PORT > fastagent.config.* http.port > 8787
```

Session directory precedence:

```txt
FASTAGENT_STATE_DIR      > <dir>/.fastagent            (the whole machine-state root)
--sessions-dir > FASTAGENT_SESSIONS_DIR > <state root>/sessions
```

For deployments, point the whole state root (auth, sessions, channel state) at durable storage:

```bash
FASTAGENT_STATE_DIR=/data/fastagent fastagent start
```

## Global options

Flags belong to their command and come **after** it: `fastagent info --json`, not
`fastagent --json info`. (Earlier releases accepted flags anywhere on the line; that form now fails
with `unknown option`, exit 2 — move the flag after the command/subcommand.)

Only two options are global:

| Option | Meaning |
|---|---|
| `-h`, `--help` | Print help. Works per command too: `fastagent deploy --help`, `fastagent help deploy`. |
| `-v`, `--version` | Print the package version. |

Recurring per-command options (same meaning everywhere they appear):

| Option | Commands | Meaning |
|---|---|---|
| `--no-input` | `dev`, `start`, `invoke`, `fire`, `login`, `deploy` | Never prompt; missing information becomes an error with the flag to pass (`deploy` plan mode only warns on a missing model — `--run` gates). |
| `--model <provider/modelId>` | assembly commands | Model override (`--model > FASTAGENT_MODEL > config`). |
| `--auth-path <file>` | assembly commands, `login` | Credentials file override. |
| `--json` | `info`, `schedule history`, `schedule list` | Machine-readable output. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including help/version displays). |
| `1` | Runtime failure — a failed turn, a broken definition, a deploy gate, an unknown tool/schedule name, invalid runtime configuration (e.g. a bad `PORT` env). |
| `2` | Usage error — unknown command/flag, missing/empty/invalid arguments, conflicting flags. A mistyped command suggests the nearest one (`fastagent depoly` → “Did you mean deploy?”). |
