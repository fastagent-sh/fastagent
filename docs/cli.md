---
title: CLI reference
description: "The fastagent CLI reference: init, login, logout, dev, invoke, info, models, build, start and deploy, with their flags, and the commands an extension adds."
status: current
---

# CLI reference

```bash
fastagent [-C <dir>] <command> [args] [options]
fastagent <command> --help     # every argument, flag and example, generated from the code
```

The agent depends on its own version of FastAgent, and a `fastagent` installed globally runs that version inside it.
Without a global install, the agent's scripts (`npm run dev`, `npm run build`, `npm start`) and
`npx @fastagent-sh/fastagent <command>` run it too. Never `npx fastagent`: that name on npm is another package.

**A running instance is operated through the process that runs it.** `invoke`
on an agent whose `dev` is running goes through that `dev`, by its Agent API, so it sees the same sessions and never
contends for its storage. With no `dev` running it opens the instance itself; with `--url` or `--remote` it acts on a
deployment.

Every command runs in the current directory; pass `-C <dir>` before the command (as in `git -C`) to run in another
agent directory (project CLI forwarding and extension resolution follow `-C` too). Nothing is searched for: from a
subdirectory, a command names the agent's root and stops.

## Commands

| Command | Does |
|---|---|
| `init <dir>` | create an agent |
| `login [provider]` | sign in to a model provider; `--check` reports whether one is ready (exit 0, 1 or 2) |
| `logout [provider]` | remove a credential `login` stored |
| `dev` | serve locally, restarting on code edits |
| `invoke [message]` | send one message (positional, `-`, or piped `stdin`) and print the answer (`--url` for a deployment) |
| `info` | show what the agent loads, without serving |
| `models [search]` | list model specs |
| `build` | compile the agent into `dist/` |
| `start` | serve the build |
| `deploy init <target>` | write container and platform files (`docker`, `compose`, `fly`, `railway`, or an installed extension such as `agentcore`) ([Deploy](deploy.md)) |
| `deploy check` | verify the definition loads and the build context leaks no local secrets or state (`--json`) |

An extension the agent installs adds a `deploy init <target>` target and commands of its own:
`npm i @fastagent-sh/agentcore` adds `fastagent deploy init agentcore` and `fastagent agentcore`
([AgentCore](agentcore.md)). Every argument after its name is the extension's, and `fastagent <name> --help` is its
own. A command or deploy target no installed extension adds exits 2, naming the package to install.

## Global options

`-C <dir>` and `-v`/`--version` come before any command: `fastagent -C ./my-agent info --json`, `fastagent --version`.
Command flags come after the command: `fastagent info --json`. `-h`/`--help` works on every command (also
`fastagent help <command>`).

| Option | Commands | Meaning |
|---|---|---|
| `-C <dir>` | before any command | Run as if `fastagent` was started in `<dir>` (including version forwarding, extensions, `login`, `models`). |
| `--bind <addr>` | `dev`, `start` | Bind address: an IP literal or `localhost`. See [Bind address](configuration.md#ports-and-bind-address). |
| `--no-input` | `dev`, `start`, `invoke`, `login`, `logout` | Never prompt; missing input or interactive steps exit 2 naming the flag or terminal command to run. |
| `--model <provider/modelId>` | assembly commands (not `deploy`) | Model for this run. `deploy` has none: the model is the configuration's. |
| `--harness <pi-durable\|dsh>` | `dev`, `start`, `invoke`, `info` | Runtime harness override (`--harness` > `FASTAGENT_HARNESS` > config > `pi-durable`). `dsh` requires `@fastagent-sh/harness-dsh`. |
| `--sandbox <workspace\|read-only\|off>` | `dev`, `start`, `invoke`, `info` | OS sandbox mode for `harness: "dsh"` (`--sandbox` > `FASTAGENT_SANDBOX` > config > `workspace`). |
| `--json` | `info`, `models`, `invoke`, `login`, `build`, `deploy check` | Machine-readable output. |
| `--url <base>`, `--remote <name>`, `--key <key>` | `invoke`, `login`, `logout` | Act on a served instance through its HTTP/AgentCore API instead of this directory's. Prefer `FASTAGENT_API_KEY` (or `--env-file`) over `--key` so keys stay out of command history. |

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
