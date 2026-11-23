---
title: CLI Reference
description: "Complete fastagent CLI reference: commands grouped by workflow, flags, exit codes, platform extensions, and scripting/coding-agent behavior."
status: current
---

# CLI Reference

```bash
fastagent [-C <dir>] <command> [args] [options]
fastagent <command> --help     # authoritative flags and examples generated from code
```

## Commands

### Create, develop & build

| Command | What it does |
| --- | --- |
| `init [dir]` | Create a new agent, adopt an existing agent directory (default `.`), or safely resume dependency install (`--no-install` skips) |
| `dev` | Serve the agent locally with live reload (`--no-watch` disables file watching) |
| `build` | Type-check and compile the agent into `dist/` (`--no-check`, `--json`) |
| `start` | Serve the compiled `dist/` build in production posture; refuses missing or stale builds |
| `info` | Inspect resolved harness, sandbox, model, tools, MCP servers, extensions, commands, secrets, and storage read-only (`--json`) |
| `models [search]` | List available `provider/modelId` specs (`-g` built-ins only; `--json`) |

### Invoke, authenticate & manage remotes

| Command | What it does |
| --- | --- |
| `invoke [message]` | Send one message (positional, `-`, or piped `stdin`), stream the answer to `stdout`, and exit (`--session`, `--conversation`, `--url`, `--remote`, `--json`) |
| `login [provider]` | Sign in to a model provider locally, globally (`-g`), or on a remote deployment (`--url` / `--remote`). With `--check`, report readiness (`ready`, `not_ready`, `invalid`) |
| `logout [provider]` | Remove a stored provider credential locally, globally (`-g`), or on a remote deployment (`--url` / `--remote`) |
| `remote list\|add\|remove\|default` | Manage saved remote endpoints in `~/.config/fastagent/remotes.json` ([Remotes & clients](remotes.md)) |

### Prepare & verify deployments

| Command | What it does |
| --- | --- |
| `deploy init <target>` | Write container and platform files (`docker`, `compose`, `fly`, `railway`, or an installed extension such as `agentcore`; `--force`, `--no-install`) ([Deploy](deploy.md)) |
| `deploy check` | Read-only CI gate verifying the definition loads and the build context leaks no local secrets or state (`--json`) |

### Platform extension commands

Installing a `@fastagent-sh/<name>` platform package adds both `fastagent deploy init <name>` and `fastagent <name> ...` (for example, `npm i @fastagent-sh/agentcore` adds `fastagent deploy init agentcore` and `fastagent agentcore init|start|invoke`). Run `fastagent <name> --help` for extension options. Calling an uninstalled extension exits `2` and names the package to install.

## Options

Global options (`-C <dir>`, `-v`/`--version`) come before the command name; command options come after. `-h`/`--help` works everywhere.

| Option | Commands | Purpose |
| --- | --- | --- |
| `-C <dir>` | before any command | Run as if started in `<dir>` (including version forwarding and extension lookup) |
| `--model <provider/modelId>` | `dev`, `start`, `invoke`, `info` | Model override (`--model` > `FASTAGENT_MODEL` > config) |
| `--harness <pi-durable\|dsh>` | `dev`, `start`, `invoke`, `info` | Runtime harness override (`--harness` > `FASTAGENT_HARNESS` > config > `pi-durable`) |
| `--sandbox <workspace\|read-only\|off>` | `dev`, `start`, `invoke`, `info` | OS sandbox mode for `harness: "dsh"` |
| `--port <n>` | `dev`, `start` | HTTP port (`dev`: default `8787`; `start`: `--port` > `PORT` > `8787`) |
| `--bind <addr>` | `dev`, `start` | Bind IP or `localhost` (`dev`: `127.0.0.1`; `start`: `0.0.0.0`) |
| `--root <dir>` | `dev`, `start`, `invoke`, `info` | Instance root override (`--root` > `FASTAGENT_ROOT` > `.fastagent/<mode>`) |
| `--name <name>` | `dev`, `start`, `invoke`, `info` | Instance name override (`--name` > `FASTAGENT_NAME`) |
| `--env-file <file>` | `dev`, `start`, `invoke`, `info`, `login`, `logout` | Secret/value file override (default `.secrets/.env`; must exist) |
| `--session <id>` | `invoke`, `remote add` | Continue an existing session id (`invoke`) or set a default session id for a saved remote (`remote add`) |
| `--conversation <name>` | `invoke` | Reuse or create a caller-named conversation session |
| `--url <base>`, `--remote <name>`, `--key <key>` | `invoke`, `login`, `logout`, `remote add` (`--key`) | Target a served deployment instead of the local directory (or save an API key / `$ENV_VAR` reference with `remote add`). Prefer `FASTAGENT_API_KEY` or `$ENV_VAR` in `remotes.json` over literal `--key` |
| `--default` | `remote add` | Make the added or updated remote the default in `remotes.json` |
| `-g, --global` | `login`, `logout`, `models` | Target global `~/.fastagent/.secrets/auth.json` (`login`/`logout`) or built-in models only (`models`) |
| `--check` | `login` | Report provider/model auth readiness without signing in (exit `0` ready, `1` not_ready, `2` invalid) |
| `--method <account\|api-key>` | `login` | Select sign-in method non-interactively |
| `--timeout <seconds>` | `login` | Interactive sign-in timeout |
| `--no-input` | `dev`, `start`, `invoke`, `login`, `logout` | Never prompt; exit `2` when required input or interactive auth is missing |
| `--json` | `info`, `models`, `invoke`, `login`, `build`, `deploy check`, `remote list` | Machine-readable JSON (or NDJSON for `invoke`) on `stdout` |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (including `--help`, `--version`, and `login --check` ready) |
| `1` | Runtime failure: non-`completed` message, open failure, failed deploy check, invalid config, or `login --check` `not_ready` |
| `2` | Usage or non-interactive input error: unknown command/flag, invalid or conflicting arguments, missing choice in non-interactive mode, or interactive step requiring a human terminal |

## How CLI resolution works

- **Version forwarding:** Inside an agent directory, a globally installed `fastagent` delegates automatically to that agent's installed version. Without a global install, use `npm run dev`/`build`/`start` or `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is another package).
- **Sharing a running `dev` server:** When `fastagent dev` is running locally, `fastagent invoke` talks to it over its Agent API automatically so both share sessions without lock contention.
- **Explicit directory targeting:** Commands run in the current directory (or `-C <dir>`). Running inside a subdirectory of an agent refuses cleanly and names the agent root rather than guessing.

## Scripting & coding-agent guarantees

Every command works reliably in CI scripts and coding-agent loops:

- **Never hangs waiting for a terminal.** Missing choices exit `2` naming the exact flag (`login --json` emits structured `need_choice` with commands).
- **Human-only steps return immediately.** OAuth browser sign-in never blocks non-interactive runs: `login --json` exits `2` with `need_user_action`, `terminal_command` for the owner, and `check_command` to verify completion.
- **Secrets stay out of conversations.** Credentials are entered in the owner's own terminal or stored in `.secrets/.env` / host secret stores.
- **Predictable streams.** Results go to `stdout`; progress, session hints, warnings, and errors go to `stderr`.
