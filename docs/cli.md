---
title: CLI reference
description: "The fastagent CLI reference: init, info, context, dev, chat, invoke, tool, start, login, models, add, routine, and deploy commands with flags."
status: current
---

# CLI reference

```bash
fastagent <command> [args] [options]
```

Most commands take an optional `[agent]`: the agent directory, the one holding `fastagent.config.ts`. The default is
the current directory. Run inside an agent's subdirectory, a command refuses and names the agent's root; anywhere
else that is not an agent, it refuses and points at `fastagent init`. Nothing is searched for.

## Commands

| Command | Purpose |
|---|---|
| `init <dir>` | Create an agent in a directory of its own; `--context` declares what it works on: a directory or a GitHub repository. |
| `info [agent]` | Show what an agent assembles into, without serving. |
| `context list\|add\|remove` | List, add or remove what the agent works on and knows. |
| `models [search]` | List model specs. |
| `login [provider]` | Store provider credentials in `<agent dir>/.secrets/auth.json`; `--deployment` logs the deployed box in. |
| `dev [agent]` | Serve locally with watch/reload. |
| `chat [agent]` | Open the assembled agent in pi's interactive TUI. |
| `invoke <message> [agent]` | Run one turn and exit. |
| `routine run <name> [agent]` | Run one routine's turn now, cron or not. |
| `routine history <name> [agent]` | Print a routine's recent fires. |
| `routine list [agent] [--json]` | Every declared routine (next cron instant, or `on demand`) plus pending wake-ups. |
| `tool <name> <json> [agent]` | Run one tool directly. |
| `add telegram\|slack\|feishu\|lark [agent]` | Scaffold a first-party channel. `add slack` creates an internal app (Manifest API + OAuth; `--no-onboard` skips it). `add feishu` scan-creates the app. `add lark` guides and validates credentials. |
| `add skill <source> [agent]` | Vendor an Agent Skills skill into `skills/`. |
| `deploy docker [agent]` | Generate `fastagent.compose.yml`, `Dockerfile` and `.dockerignore` for local Docker (one `agent` service, loopback port, `/data` volume). `--tunnel --run` also starts a Quick Tunnel and registers webhooks. |
| `deploy fly [agent]` | Generate `fly.toml`, `Dockerfile` and `.dockerignore` and print a flyctl runbook. `--run` drives flyctl to completion. |
| `deploy railway [agent]` | Generate `railway.json`, `Dockerfile` and `.dockerignore` and print a railway runbook. `--run` provisions an unlinked dir end to end; a linked one needs `--into-linked`. |
| `deploy agentcore [agent]` | Generate `agentcore.template.yaml`, `lambda/index.js` and image artifacts. `--run` builds and pushes an arm64 image, deploys the stack, registers webhooks, and stops the runtime session so the next call uses the new image. |
| `logs agentcore [agent]` | Tail the deployed Runtime's CloudWatch logs; `--source forwarder` selects the forwarder Lambda. `--since <duration>`, `--follow`. |
| `destroy agentcore [agent] [--run]` | Delete what `deploy agentcore` created: stack, artifact bucket, ECR repository, both log groups, pending wake alarms. Without `--run` it only lists them. A stack that does not reach `DELETE_COMPLETE` stops the rest. |
| `start [agent]` | Serve without watch. |

`deploy` writes artifacts and prints a runbook; only `--run` touches a host. Existing artifacts are kept unless
`--force`; a generated one that no longer matches the definition is flagged stale and gates `--run`. See
[Deploy](deploy.md).

## `fastagent init`

```bash
fastagent init <dir> [--context <source>]... [--no-install]
```

Creates the agent in `<dir>` itself, which must be new or empty: `APPEND_SYSTEM.md`, a `writing-great-skills`
example skill, a `fetch-url` example tool, `fastagent.config.ts`, `package.json`, `.secrets/.env.example`,
`.gitignore` and `.secrets/.gitignore`. It runs `npm install` unless `--no-install`.

Each `--context <source>` declares something the agent works on in the config's `contexts` list (see
[contexts](configuration.md#contexts)), read the way `context add` reads it:

| `<source>` | Declared |
|---|---|
| `github:owner/repo` | `{ github: "owner/repo" }`, cloned when the agent starts and brought up to date in place at each start |
| The root of a checkout whose `origin` is on GitHub | `{ github: "owner/repo", local: "<checkout root>" }` |
| Any other directory, a subdirectory of such a checkout included | `{ local: "<absolute path>" }`; for a subdirectory, a note names the `github:` form, which is the whole repository |

A directory stays on this machine: a deployed instance works without it, and `deploy` says so. A repository is cloned
on a host. Every context is checked before anything is written: a directory must exist,
and no declared location may contain the agent directory or sit inside it. Without `--context` the agent has none
and works only in its own directory.

`init` refuses a directory that is not empty, inside a project as anywhere else, and names the command that creates
the agent elsewhere and attaches the project: `fastagent init <new directory> --context <project>`. It also refuses a
directory inside another agent. To deploy, keep the directory's name to letters, digits, `-` and `_`.

A `fastagent.config.ts` makes a directory an agent, whatever its name. Its contents may be `export default {}`.

## `fastagent info`

```bash
fastagent info [agent] [--json] [--model provider/modelId]
```

Prints, without serving:

- the agent directory, its contexts (`works on` / `knows`, each with its location), config path, model and its
  source,
- the prompt (pi's default or `SYSTEM.md`, plus `APPEND_SYSTEM.md`),
- skills (each context's named `<context>/<skill>`) and their diagnostics,
- coding tools, authored tools and collisions,
- channels that import cleanly (a failing one is reported, and listed as `channelFailures` in `--json`),
- routines with their next fire instant (a broken routine file is reported),
- declared secrets, flagging any with no value here (`dev`/`start` refuse to boot without them),
- state, sessions and auth paths.

A context that cannot be resolved (its directory is missing, say) is reported, not fatal. `--json` carries
`contexts`, `contextsError` and `contextFiles` (each context's `AGENTS.md`). Read-only.

## `fastagent context`

```bash
fastagent context list [agent] [--json]
fastagent context add <source> [agent] [--readonly] [--ref <ref>] [--local <dir>] [--name <name>]
fastagent context remove <name> [agent]
```

Edits the literal `contexts` list in `fastagent.config.ts`. `add` reads `<source>` the way `init --context` does: a
directory, the root of a GitHub checkout (declared as that repository, with the checkout as its `local`), or
`github:owner/repo`. Paths are written absolute. `--readonly` makes it a context the agent knows rather than works
on; `--ref` names a repository's branch, tag or commit; `--local` names the checkout of a
`github:owner/repo` on this machine. A context's name defaults to its directory's or repository's; `add` asks for
`--name` when that name is taken (ignoring case) or is not one segment of letters, digits, `-` and `_`. `remove`
drops the declaration; the directory or checkout itself is untouched.

Both write a candidate file beside the config, import it, and replace the config only when it declares exactly the
intended list, so a refusal leaves the config as it was. A list that is computed (a variable, a spread) is refused:
edit it by hand. `list --json` prints each context as every command resolves it, with its `notices`: a checkout off
its `ref`, a clone not made yet.

## `fastagent models`

```bash
fastagent models [search] [--refresh] [-g|--global]
```

Lists the model specs (`provider/modelId`) the agent in the current directory can name, optionally filtered: pi's
built-ins, its `models-store.json` and `models.json` over the machine's (`~/.fastagent/`). Outside an agent, or with
`-g`, it lists the machine's. Inside an agent's subdirectory it refuses (as `login` does) rather than list the
machine's without the agent's own files: `cd` to the agent, or pass `-g`.

`--refresh` first fetches the model catalog from pi.dev into `models-store.json`, so models released after the
installed pi appear: the agent's, with its credentials (commit the file; it ships with a deploy), or with `-g` the
machine's, with the global credentials file and the environment (every agent here reads it; it does not ship). It
fails, naming the provider, when the refresh does, and when no provider has a usable credential. See
[configuration](configuration.md#models-newer-than-pi-models-storejson).

## `fastagent login`

```bash
fastagent login [provider] [-g|--global] [--deployment [host]] [--no-input]
```

Writes to `<agent dir>/.secrets/auth.json` (overrides: `FASTAGENT_SECRETS_DIR`, `FASTAGENT_AUTH_PATH`). `-g`, or
running outside any agent, writes `~/.fastagent/.secrets/auth.json`. Inside an agent but not at its root, it
refuses and says where to `cd`.

- An agent reads the global file for a provider it has no credential of its own for: no entry in its `auth.json`, no
  `apiKey` in its `models.json`, no env variable ([order](configuration.md#auth-and-secrets)). So one `login -g`
  serves every agent on the machine that has nothing else for that provider. A refresh is written back to the file
  it was read from. `login` warns when an env variable already authenticates the provider, because the global login
  is then not used.
- `--deployment [host]` logs this agent's deployment in instead: the login runs on the box (Docker, Fly, Railway,
  AgentCore) and the credential stays there. `deploy` never carries `auth.json`. See
  [Logging a deployment in](deploy.md#logging-a-deployment-in).
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
fastagent dev [agent] [--port N] [--bind addr] [--model provider/modelId] [--no-watch] [--tunnel] [--no-invoke] [--no-input]
```

Serves the agent locally. `SYSTEM.md`, `APPEND_SYSTEM.md`, each context's `AGENTS.md`, skills and prompt templates
are re-read every turn. A supervisor restarts the
worker on edits to `tools/`, `channels/`, `routines/`, `fastagent.config.ts`, `package.json` and `.secrets/.env`,
once the turns running in it finish (at most 10 minutes, after which it restarts anyway and says how many it cut), so
an agent that edits its own `tools/` does not cut off the turn that made the edit.

With no model set and a terminal attached, commands that need one (`dev`, `start`, `invoke`, `routine run`,
`chat`, `deploy`) show the model catalog and write the pick to the config.

`--tunnel` opens a Cloudflare Quick Tunnel (needs `cloudflared`), prints the public URL, and registers webhooks
where it can; see [Local webhook development](channels.md#local-webhook-development).

## `fastagent chat`

```bash
fastagent chat [agent] [--model provider/modelId]
```

Opens the agent in pi's TUI with the definition's prompt files, its contexts' `AGENTS.md`, skills, prompt
templates, `tools/` and `extensions/`, plus the machine's skills and prompt templates. Your pi extensions and `APPEND_SYSTEM.md` are not loaded.

- Sessions are pi's per-directory records (`~/.pi/agent/sessions/<encoded agent directory>`), separate from served
  sessions.
- Auth is fastagent's (`FASTAGENT_AUTH_PATH` > the agent's `auth.json`); pi's `/login` writes to the same file.
- TUI settings (theme, keybindings, editor) come from `~/.pi/agent/settings.json`. Reasoning effort comes from
  `thinkingLevel` in `fastagent.config.ts`, as when serving.

## `fastagent invoke`

```bash
fastagent invoke <message> [agent] [--model provider/modelId] [--no-input]
```

Runs one turn and exits: answer text to stdout, tool and diagnostic lines to stderr, non-zero exit on `failed`.

## `fastagent routine run`

```bash
fastagent routine run <name> [agent] [--model provider/modelId] [--no-input]
```

Fires `routines/<name>.ts` now, in the routine's session, and streams like `invoke`. It does not advance the
routine's fire state. No name → exit 2; an unknown name → exit 1 with the available names. See
[Routine authoring](api-reference.md#routine-authoring).

## `fastagent routine history`

```bash
fastagent routine history <name> [agent] [--json]
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
fastagent routine list [agent] [--json]
```

Lists every declared routine with its next cron instant (or `on demand`), and the agent's pending wake-ups (id,
next fire, one-shot or cron, session, prompt). The agent cancels its own wake-ups with `unwake({ id })`; as a last
resort, edit `<state root>/schedule/wakeups.json`.

## `fastagent tool`

```bash
fastagent tool <name> '<json-args>' [agent]
```

Runs one tool directly, without a model or server. It gets the agent directory as `cwd` and the agent's contexts,
but no session.

```bash
fastagent tool fetch-url '{"url":"https://example.com"}'
```

The result goes to stdout; stderr reports its size in model tokens. See
[Output budget](api-reference.md#output-budget).

## `fastagent add telegram|slack|feishu|lark`

```bash
fastagent add telegram [agent]
fastagent add slack [agent]    # create/install an internal app; --no-onboard scaffolds only
fastagent add feishu [agent]   # 飞书: scan-to-create the app
fastagent add lark [agent]     # Lark international: console + credential validation
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
fastagent add skill <source> [agent] [--update]
```

Vendors a skill into the agent's `skills/<name>/`. `<source>` is a GitHub-style ref, a local path, or a bare name
from the machine's skill directories. `--update` overwrites an existing one.

## `fastagent start`

```bash
fastagent start [agent] [--port N] [--bind addr] [--model provider/modelId] [--tunnel] [--no-invoke] [--no-input]
```

Serves without watch. Binds all interfaces by default.

```txt
port:     --port > PORT > fastagent.config.ts http.port > 8787
bind:     --bind > all interfaces
/invoke:  --no-invoke > fastagent.config.ts http.invoke > served
state:    FASTAGENT_STATE_DIR   > <agent dir>/.state
secrets:  FASTAGENT_SECRETS_DIR > <agent dir>/.secrets
```

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
