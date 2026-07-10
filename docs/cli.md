---
title: CLI reference
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
| `schedule list [dir]` | Everything that will fire: static schedules (next instant) + pending wake-ups. |
| `schedule cancel <id> [dir]` | Remove a pending wake-up (operator kill switch). |
| `tool <name> <json> [dir]` | Run one discovered tool directly. |
| `add github|telegram|lark [dir]` | Scaffold a first-party channel. `lark --create-app` also creates + configures the Feishu/Lark app itself from a scan and writes the credentials to `.env`. |
| `add skill <source> [dir]` | Vendor an Agent Skills skill into `skills/`. |
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
fastagent info [dir] [--json] [--auth-path file]
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
fastagent login [provider] [--auth-path file]
```

Authenticates a model provider and stores credentials in the **project-level** `<state root>/auth.json` — by default `<cwd>/.fastagent/auth.json` (root override: `FASTAGENT_STATE_DIR`; file override: `--auth-path` / `FASTAGENT_AUTH_PATH`; run it from `$HOME` to write the global `~/.fastagent/auth.json`). There is no implicit fallback between the project and global files — the default is project-level for **isolation** (different agents can use different accounts) and **fail-visibly** (a missing credential surfaces instead of being masked by a machine-global one absent on a fresh box). So `cd` into your agent before logging in. FastAgent uses its own credential file, separate from pi's CLI state.

**Running several agents off one account on your dev machine?** Point them all at the one global file: set `FASTAGENT_AUTH_PATH=~/.fastagent/auth.json` (a `.env` entry, a shell env var, or `--auth-path`), or just `login`/run from `$HOME`. A leading `~` is expanded to your home dir in `--auth-path` and `FASTAGENT_AUTH_PATH` (shell variables like `$HOME` are not — use `~` or an absolute path). Sharing **one file** is safe — a single cross-process lock serializes OAuth refresh, so concurrent instances always read the latest token. (What is *not* safe is copying the file around: two files over one grant each rotate the single-use refresh token and break the other.)

## `fastagent dev`

```bash
fastagent dev [dir] [--port N] [--model provider/modelId] [--auth-path file] [--no-watch] [--tunnel]
```

Assembles the workspace and serves it locally. persona.md/AGENTS.md/`skills/` are re-read every turn (edits go
live next turn, no restart); a supervisor restarts the worker on edits to the code inputs —
`tools/`, `channels/`, `fastagent.config.*`, `package.json`, `.env`.

With no model set and a terminal attached, `dev` first prompts you to pick one from the providers you
are logged into and writes it back to the config (same for `start` / `invoke`); pass `--model` or set
`FASTAGENT_MODEL` to skip the prompt.

Options:

| Option | Meaning |
|---|---|
| `--port N` | Override `http.port` / default `8787`. |
| `--model spec` | Override model selection. |
| `--no-watch` | Serve once without the watch supervisor. |
| `--tunnel` | Open a Cloudflare quick tunnel for webhook testing. |

Model precedence:

```txt
--model > FASTAGENT_MODEL > fastagent.config.* model
```

## `fastagent chat`

```bash
fastagent chat [dir] [--model provider/modelId]
```

Opens the same assembled workspace in pi's interactive TUI. This is useful for trying the agent before serving it through channels.

## `fastagent invoke`

```bash
fastagent invoke <message> [dir] [--model provider/modelId] [--auth-path file]
```

Runs one turn through the same workspace assembly and exits:

- answer text streams to stdout,
- tool and diagnostic lines go to stderr,
- a `failed` terminal event exits non-zero.

Use this for smoke tests and scripts.

## `fastagent fire`

```bash
fastagent fire <name> [dir] [--model provider/modelId] [--auth-path file]
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
fire, one-shot/cron, session, prompt); `fastagent schedule cancel <id> [dir]` removes one wake-up — the
operator's kill switch for a runaway recurring wake (the agent's own is the `unwake` tool, which is
session-scoped).

## `fastagent tool`

```bash
fastagent tool <name> '<json-args>' [dir]
```

Runs one discovered or configured tool directly, without a model or server.

Example:

```bash
fastagent tool fetch-url '{"url":"https://example.com"}'
```

## `fastagent add github|telegram|lark`

```bash
fastagent add github [dir]
fastagent add telegram [dir]
fastagent add lark [dir]
fastagent add lark --create-app [dir]   # also CREATE the Feishu/Lark app (scan-to-create; credentials → .env)
```

Creates a `channels/<kind>.ts` file with adapter glue and appends env placeholders to `.env.example` when possible. When `.env` is gitignored, the channel's GENERATED secrets (telegram's `TELEGRAM_SECRET_TOKEN`, github's `GITHUB_WEBHOOK_SECRET` — random strings the user contributes nothing to) are also written to the run-root `.env`, leaving only genuinely-manual values (e.g. `TELEGRAM_BOT_TOKEN` from BotFather) as next steps. When `config.agentDir` is set, the channel (and any companion tool) lands under that subdirectory — the same place `dev`/`start` discover channels — while `.env.example` and the secret hygiene stay at the run root, where `.env` is read.

An enabled `channels/*.ts|*.js|*.mjs` file must load successfully or `dev` / `start` fails. To
intentionally disable one, rename it to e.g. `channels/telegram.ts.disabled`; channel files, not config,
are the enable/disable source of truth.

See:

- [GitHub channel](github.md)
- [Telegram channel](telegram.md)
- [Lark / Feishu channel](lark.md)

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
fastagent start [dir] [--port N] [--model provider/modelId] [--sessions-dir dir] [--auth-path file] [--tunnel]
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

| Option | Meaning |
|---|---|
| `-h`, `--help` | Print CLI help. |
| `-v`, `--version` | Print the package version. |
