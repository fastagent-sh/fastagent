---
title: CLI reference
description: "The fastagent CLI reference: init, info, models, login, logout, auth, dev, invoke, start, schedules, add, and deploy, with their flags."
status: current
---

# CLI reference

```bash
fastagent <command> [args] [options]
fastagent <command> --help     # every argument, flag and example, generated from the code
```

`[agent]` is the agent directory (the one with `fastagent.config.ts`), by default the current one. Nothing is searched
for: from a subdirectory, a command names the agent's root and stops.

## Commands

| Command | Does |
|---|---|
| `init <dir>` | create an agent |
| `info` | show what the agent loads, without serving |
| `dev` | serve locally, restarting on code edits |
| `invoke <message>` | send one message and print the answer (`--url` for a deployment) |
| `build` | compile the agent into `dist/` |
| `start` | serve the build |
| `models [search]` | list model specs |
| `login [provider]`, `logout`, `auth check` | manage model credentials |
| `schedules list\|run\|unwake` | inspect, run now, or cancel a wake-up |
| `deploy docker` | write the `Dockerfile` and `.dockerignore`, and print how to run them ([Deploy](deploy.md)) |

## Global options

Flags come after the command: `fastagent info --json`. `-h`/`--help` works on every command (also
`fastagent help <command>`); `-v`/`--version` comes before any command: `fastagent --version`.

| Option | Commands | Meaning |
|---|---|---|
| `--bind <addr>` | `dev`, `start` | Bind address: an IP literal or `localhost`. See [Bind address](configuration.md#ports-and-bind-address). |
| `--no-input` | `dev`, `start`, `invoke`, `schedules run`, `login`, `logout`, `deploy` | Never prompt; missing input or interactive steps exit 2 naming the flag or terminal command to run. |
| `--model <provider/modelId>` | assembly commands (not `deploy`) | Model for this run. `deploy` has none: the model is the configuration's. |
| `--json` | `info`, `models`, `invoke`, `schedules list`, `login`, `auth check`, `add` | Machine-readable output. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including help and version). |
| `1` | Runtime failure: a message that did not complete, a definition that does not open, a deploy gate, an unsupported runtime, invalid configuration. |
| `2` | Usage error: unknown command or flag, missing or invalid arguments, conflicting flags, or a choice a terminal would have asked for (a default model, a provider to sign in to) with none there to ask. A mistyped command suggests the nearest one. |

## Scripts and coding agents

Every command serves a person at a terminal, and a script or a coding agent without one. A coding agent works in
turns: it runs a command, reads what it printed once it ends, then talks to its user. So:

- **Nothing waits on a terminal.** A choice a terminal would ask for has a flag or an argument. Without a terminal,
  or with `--no-input` or `--json`, a choice not given ends the command, exit 2, naming what to pass (`login --json`
  answers `need_choice` with a command for each).
- **A step only a person can take returns at once (`exit 2`)**: `login --json` never blocks or spawns a background
  daemon without a terminal; when browser sign-in is required it exits 2 (`need_user_action` / `need_choice`) naming
  the terminal command and the verification command, then exits 0 once satisfied.
- **A secret never passes through the agent's conversation.** The person types it at a terminal of their own, or writes
  it where the command names (the agent's `.secrets/.env`) without sending it through the agent.
- **Results on stdout, everything else on stderr**: progress, notes, warnings and errors. A command whose result is
  data has `--json`.
- **The exit code says how it ended**: 0, 1 or 2, as above.
