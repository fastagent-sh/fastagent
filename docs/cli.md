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
| `tool <name> <json> [dir]` | Run one discovered tool directly. |
| `add github|telegram [dir]` | Scaffold a first-party channel. |
| `add skill <source> [dir]` | Vendor an Agent Skills skill into `skills/`. |
| `deploy fly [dir]` | Generate Fly.io artifacts (`fly.toml`/`Dockerfile`/`.dockerignore`, autostop=suspend, state→volume) from the definition and print a flyctl runbook + webhook step. Does not run flyctl. `--stop` (stop instead of suspend), `--no-scale-to-zero` (keep one machine up), `--force` (overwrite artifacts). |
| `start [dir]` | Serve without watch. |

## `fastagent init`

```bash
fastagent init [dir] [--minimal] [--no-install]
```

Creates a self-iterating agent — the folder is the agent, and it can edit its own definition (AGENTS.md and skills are re-read every turn). A fresh workspace has `AGENTS.md` (the persona: how to improve yourself), a `writing-great-skills` example skill (from [mattpocock/skills](https://github.com/mattpocock/skills) — the guide to authoring skills), a `fetch-url` example code tool, config, `.env.example`, and `.gitignore`. Everything is written offline; by default it also writes `package.json` and runs `npm install`.

Options:

| Option | Meaning |
|---|---|
| `--minimal` | AGENTS.md + the example skill + config only — no code tool, package.json, or install. |
| `--no-install` | Scaffold everything but skip `npm install`. |

## `fastagent info`

```bash
fastagent info [dir] [--json] [--auth-path file]
```

Prints the assembled surface without starting a server:

- model source,
- config path,
- `AGENTS.md` presence,
- skills and diagnostics,
- non-default tools and collisions,
- channel files,
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

Assembles the workspace and serves it locally. AGENTS.md/`skills/` are re-read every turn (edits go
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

## `fastagent tool`

```bash
fastagent tool <name> '<json-args>' [dir]
```

Runs one discovered or configured tool directly, without a model or server.

Example:

```bash
fastagent tool fetch-url '{"url":"https://example.com"}'
```

## `fastagent add github|telegram`

```bash
fastagent add github [dir]
fastagent add telegram [dir]
```

Creates a `channels/<kind>.ts` file with adapter glue and appends env placeholders to `.env.example` when possible.

See:

- [GitHub channel](github.md)
- [Telegram channel](telegram.md)

## `fastagent add skill`

```bash
fastagent add skill <source> [dir] [--update]
```

Vendors an Agent Skills skill into `skills/<name>/`. Sources can be:

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

For deployments, point sessions at durable storage:

```bash
FASTAGENT_SESSIONS_DIR=/data/sessions fastagent start
```

## Global options

| Option | Meaning |
|---|---|
| `-h`, `--help` | Print CLI help. |
| `-v`, `--version` | Print the package version. |
