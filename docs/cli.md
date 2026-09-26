---
title: CLI reference
description: "The fastagent CLI reference: init, info, dev, chat, invoke, tool, start, login, models, add, routine, and deploy commands with flags."
status: current
---

# CLI reference

```bash
fastagent <command> [args] [options]
```

Most commands take an optional workspace directory (the agent is there, or in its `./fastagent/`). The default is
the current directory.

## Commands

| Command | Purpose |
|---|---|
| `init [dir]` | Scaffold a runnable agent. |
| `info [dir]` | Show what an agent assembles into, without serving. |
| `models [search]` | List model specs. |
| `login [provider]` | Store provider credentials in `<agent dir>/.secrets/auth.json`. |
| `dev [dir]` | Serve locally with watch/reload. |
| `chat [dir]` | Open the assembled agent in pi's interactive TUI. |
| `invoke <message> [dir]` | Run one turn and exit. |
| `routine run <name> [dir]` | Run one routine's turn now, cron or not. |
| `routine history <name> [dir]` | Print a routine's recent fires. |
| `routine list [dir] [--json]` | Every declared routine (next cron instant, or `on demand`) plus pending wake-ups. |
| `tool <name> <json> [dir]` | Run one tool directly. |
| `add telegram\|slack\|feishu\|lark [dir]` | Scaffold a first-party channel. `add slack` creates an internal app (Manifest API + OAuth; `--no-onboard` skips it). `add feishu` scan-creates the app. `add lark` guides and validates credentials. |
| `add skill <source> [dir]` | Vendor an Agent Skills skill into `skills/`. |
| `deploy docker [dir]` | Generate `fastagent.compose.yml`, `Dockerfile` and `.dockerignore` for local Docker (one `agent` service, loopback port, `/data` volume). `--tunnel --run` also starts a Quick Tunnel and registers webhooks. |
| `deploy fly [dir]` | Generate `fly.toml`, `Dockerfile` and `.dockerignore` and print a flyctl runbook. `--run` drives flyctl to completion. |
| `deploy railway [dir]` | Generate `railway.json`, `Dockerfile` and `.dockerignore` and print a railway runbook. `--run` provisions an unlinked dir end to end; a linked one needs `--into-linked`. |
| `deploy agentcore [dir]` | Generate `agentcore.template.yaml`, `lambda/index.js` and image artifacts. `--run` builds and pushes an arm64 image, deploys the stack, registers webhooks, and stops the runtime session so the next call uses the new image. |
| `logs agentcore [dir]` | Tail the deployed Runtime's CloudWatch logs; `--source forwarder` selects the forwarder Lambda. `--since <duration>`, `--follow`. |
| `destroy agentcore [dir] [--run]` | Delete what `deploy agentcore` created: stack, artifact bucket, ECR repository, both log groups, pending wake alarms. Without `--run` it only lists them. A stack that does not reach `DELETE_COMPLETE` stops the rest. |
| `start [dir]` | Serve without watch. |

`deploy` writes artifacts and prints a runbook; only `--run` touches a host. Existing artifacts are kept unless
`--force`; a generated one that no longer matches the definition is flagged stale and gates `--run`. See
[Deploy](deploy.md).

## `fastagent init`

```bash
fastagent init [dir] [--no-install] [--agent-dir <name>]
```

Creates the agent in `./fastagent/` (or `--agent-dir <name>`) inside `dir`: `persona.md`, a
`writing-great-skills` example skill, a `fetch-url` example tool, `fastagent.config.ts`, `package.json`,
`.secrets/.env.example`, `.gitignore` and `.secrets/.gitignore`. It runs `npm install` unless `--no-install`. No
`AGENTS.md` is scaffolded; an existing one in the workspace is read as project context. The directory around the
agent gets no writes and becomes its workspace.

`init` refuses when the target already holds a `fastagent.config.ts` or other content. `--agent-dir` must be a
single directory name; to deploy, keep it to letters, digits, `-` and `_`. A second agent beside an existing one is
supported; see [More than one agent](configuration.md#more-than-one-agent).

A `fastagent.config.ts` makes a directory an agent, whatever its name. Its contents may be `export default {}`.

## `fastagent info`

```bash
fastagent info [dir] [--json] [--model provider/modelId]
```

Prints, without serving:

- agent and workspace directories, config path, model and its source,
- persona and context files (`AGENTS.md`),
- skills and their diagnostics,
- coding tools, authored tools and collisions,
- channels that import cleanly (a failing one is reported, and listed as `channelFailures` in `--json`),
- routines with their next fire instant (a broken routine file is reported),
- declared secrets, flagging any with no value here (`dev`/`start` refuse to boot without them),
- state, sessions and auth paths.

Read-only.

## `fastagent models`

```bash
fastagent models [search]
```

Lists model specs (`provider/modelId`), optionally filtered.

## `fastagent login`

```bash
fastagent login [provider] [-g|--global] [--no-input]
```

Writes to `<agent dir>/.secrets/auth.json` (overrides: `FASTAGENT_SECRETS_DIR`, `FASTAGENT_AUTH_PATH`). `-g`, or
running outside any agent, writes `~/.fastagent/.secrets/auth.json`. Inside an agent but not at its root, it
refuses and says where to `cd`.

- An agent reads the global file for any provider its own file lacks, so one `login -g` serves every agent on the
  machine. A refresh is written back to the file it was read from.
- `deploy` carries the project file only. After `login -g`, deploy with
  `FASTAGENT_AUTH_PATH=~/.fastagent/.secrets/auth.json`, or run `fastagent login` in the agent dir.
- Several processes can share one `auth.json` safely (OAuth refresh is locked). Do not copy an OAuth `auth.json`:
  each copy rotates the single-use refresh token and breaks the other.
- An API-key login is checked with one request to pi's default model for the provider, before the key is written.
  A 401 is never stored, so the file keeps what it held, and the key is asked for again; other failures keep the
  key and print the provider's message. Inside an agent the check goes to the endpoint its `models.json` names (a
  gateway in front of a built-in provider, say); with `-g` it goes to the provider's own endpoint.
- `auth.json` is always written `0600`. `.secrets/.env` is `0600` only when fastagent creates it; directories keep
  the permissions you gave them.

## `fastagent dev`

```bash
fastagent dev [dir] [--port N] [--bind addr] [--model provider/modelId] [--no-watch] [--tunnel] [--no-invoke] [--no-input]
```

Serves the agent locally. `persona.md`, `AGENTS.md` and `skills/` are re-read every turn. A supervisor restarts the
worker on edits to `tools/`, `channels/`, `routines/`, `fastagent.config.ts`, `package.json` and `.secrets/.env`.

With no model set and a terminal attached, commands that need one (`dev`, `start`, `invoke`, `routine run`,
`chat`, `deploy`) show the model catalog and write the pick to the config.

`--tunnel` opens a Cloudflare Quick Tunnel (needs `cloudflared`), prints the public URL, and registers webhooks
where it can; see [Local webhook development](channels.md#local-webhook-development).

## `fastagent chat`

```bash
fastagent chat [dir] [--model provider/modelId]
```

Opens the agent in pi's TUI with the definition's `persona.md`, `AGENTS.md`, `skills/`, `tools/` and `extensions/`,
plus the machine's skills and prompt templates. Your pi extensions and `APPEND_SYSTEM.md` are not loaded.

- Sessions are pi's per-workspace records (`~/.pi/agent/sessions/<encoded workspace>`), separate from served
  sessions.
- Auth is fastagent's (`FASTAGENT_AUTH_PATH` > the agent's `auth.json`); pi's `/login` writes to the same file.
- TUI settings (theme, keybindings, editor) come from `~/.pi/agent/settings.json`. Reasoning effort comes from
  `thinkingLevel` in `fastagent.config.ts`, as when serving.

## `fastagent invoke`

```bash
fastagent invoke <message> [dir] [--model provider/modelId] [--no-input]
```

Runs one turn and exits: answer text to stdout, tool and diagnostic lines to stderr, non-zero exit on `failed`.

## `fastagent routine run`

```bash
fastagent routine run <name> [dir] [--model provider/modelId] [--no-input]
```

Fires `routines/<name>.ts` now, in the routine's session, and streams like `invoke`. It does not advance the
routine's fire state. No name → exit 2; an unknown name → exit 1 with the available names. See
[Routine authoring](api-reference.md#routine-authoring).

## `fastagent routine history`

```bash
fastagent routine history <name> [dir] [--json]
```

Prints a routine's recent fires: time, outcome, and duration. Text output shows the last 20; `--json` shows all
retained fires (the last 512).

| Outcome | Meaning |
|---|---|
| `completed` / `failed` | The turn finished, or failed. |
| `interrupted` | The process stopped mid-turn. The slot is not replayed; the next resident start records it. |
| `unreported` | Still running, or never settled (AgentCore has no resident start to record it). |

What a fire said is in its session (`routine:<name>` under `<state root>/sessions/`), whose path this command
prints. A failure before the model was reached (credentials, model, a missing secret) is only in the logs, under
the host's retention.

Wake-ups have no history here, only log lines.

## `fastagent routine list`

```bash
fastagent routine list [dir] [--json]
```

Lists every declared routine with its next cron instant (or `on demand`), and the agent's pending wake-ups (id,
next fire, one-shot or cron, session, prompt). The agent cancels its own wake-ups with `unwake({ id })`; as a last
resort, edit `<state root>/schedule/wakeups.json`.

## `fastagent tool`

```bash
fastagent tool <name> '<json-args>' [dir]
```

Runs one tool directly, without a model or server. It gets the workspace cwd but no session.

```bash
fastagent tool fetch-url '{"url":"https://example.com"}'
```

The result goes to stdout; stderr reports its size in model tokens. See
[Output budget](api-reference.md#output-budget).

## `fastagent add telegram|slack|feishu|lark`

```bash
fastagent add telegram [dir]
fastagent add slack [dir]    # create/install an internal app; --no-onboard scaffolds only
fastagent add feishu [dir]   # 飞书: scan-to-create the app
fastagent add lark [dir]     # Lark international: console + credential validation
                             # feishu/lark take --ingress websocket|webhook (asked when omitted)
```

Writes `channels/<kind>.ts` (yours after that) and a companion send tool (`tools/<kind>-send.ts`, rewritten on
every `add`), appends variables to `.secrets/.env.example`, and writes generated secrets such as
`TELEGRAM_SECRET_TOKEN` to `.secrets/.env`. Re-run `add <kind>` after upgrading the package to refresh the send
tool.

Slack:

- `--group-behavior context|mentions` picks the app's scopes: `context` (default) hears channel messages,
  `mentions` is least privilege.
- Onboarding creates the app through `apps.manifest.create`, installs it through OAuth, and writes the bot token
  and signing secret to `.secrets/.env`. The App Configuration token stays in `<state root>/channels/slack/` on
  this machine; `dev --tunnel` and `deploy --run` use it to update the Request URL.
- `--replace-config` replaces that token pair when it has expired or been revoked. Other machines set the Request
  URL in the Slack console.

See [Telegram](telegram.md), [Slack](slack.md), [Feishu (Lark compatibility)](feishu.md).

## `fastagent add skill`

```bash
fastagent add skill <source> [dir] [--update]
```

Vendors a skill into the agent's `skills/<name>/`. `<source>` is a GitHub-style ref, a local path, or a bare name
from the machine's skill directories. `--update` overwrites an existing one.

## `fastagent start`

```bash
fastagent start [dir] [--port N] [--bind addr] [--model provider/modelId] [--tunnel] [--no-invoke] [--no-input]
```

Serves without watch. Binds all interfaces by default.

```txt
port:     --port > PORT > fastagent.config.ts http.port > 8787
bind:     --bind > all interfaces
/invoke:  --no-invoke > fastagent.config.ts http.invoke > served
state:    FASTAGENT_STATE_DIR   > <agent dir>/.state
secrets:  FASTAGENT_SECRETS_DIR > <agent dir>/.secrets
```

`FASTAGENT_AGENT` selects the agent by directory name when a workspace holds several; a name that matches nothing
fails. Set it per repository (`.envrc`) or per command. `deploy` bakes the selected agent into the image.

## Global options

Flags come after the command: `fastagent info --json`. Global: `-h`/`--help` (also per command, and
`fastagent help <command>`) and `-v`/`--version`.

| Option | Commands | Meaning |
|---|---|---|
| `--bind <addr>` | `dev`, `start` | Bind address: an IP literal or `localhost`. See [Bind address](configuration.md#bind-address). |
| `--no-invoke` | `dev`, `start` | Do not serve `POST /invoke`, `POST /run` or `GET /routines` on this run, whatever the config says. For a `dev --tunnel` session whose only intended ingress is signed channel webhooks. |
| `--no-input` | `dev`, `start`, `invoke`, `routine run`, `login`, `deploy` | Never prompt; missing input is an error naming the flag to pass. |
| `--model <provider/modelId>` | assembly commands (not `deploy`) | Model for this run. `deploy` reads `FASTAGENT_MODEL` from `.secrets/.env`, then `config.model`. |
| `--json` | `info`, `routine history`, `routine list` | Machine-readable output. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including help and version). |
| `1` | Runtime failure: a failed turn, a broken definition, a deploy gate, an unknown tool or routine name, invalid runtime configuration. |
| `2` | Usage error: unknown command or flag, missing or invalid arguments, conflicting flags. A mistyped command suggests the nearest one. |
