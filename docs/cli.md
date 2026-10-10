---
title: CLI reference
description: "The fastagent CLI reference: init, info, content, dev, chat, invoke, tool, start, login, models, add, schedules, and deploy commands with flags."
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
| `init <dir>` | Create an agent in a directory of its own; `--content` declares what it works on: a directory or a GitHub repository. |
| `info [agent]` | Show what an agent assembles into, without serving. |
| `content list\|add\|remove` | List, add or remove what the agent works on and knows. |
| `env <mise args>` | Run the agent's own mise on its `mise.toml`: the commands the agent needs. |
| `models [search]` | List model specs. |
| `login [provider]` | Store provider credentials in `<agent dir>/.secrets/auth.json`; `--deployment` logs the deployed box in. |
| `dev [agent]` | Serve locally with watch/reload. |
| `chat [agent]` | Open the assembled agent in pi's interactive TUI. |
| `invoke <message> [agent]` | Run one turn and exit. |
| `schedules list [agent] [--json]` | Every schedule (next instant, last run, session) plus pending wake-ups. |
| `tool <name> <json> [agent]` | Run one tool directly. |
| `add telegram\|slack\|feishu\|lark [agent]` | Scaffold a first-party channel. `add slack` creates an internal app (Manifest API + OAuth; `--no-onboard` skips it). `add feishu` scan-creates the app. `add lark` guides and validates credentials. With `--no-onboard`, each writes only the channel (if missing) and its tools, which is how an existing agent picks up a new tool. |
| `add skill <source> [agent]` | Vendor an Agent Skills skill into `skills/`. |
| `deploy docker [agent]` | Generate `fastagent.compose.yml`, `Dockerfile` and `.dockerignore` for local Docker (one `agent` service, loopback port, `/data` volume). `--tunnel --run` also starts a Quick Tunnel and registers webhooks. |
| `deploy fly [agent]` | Generate `fly.toml`, `Dockerfile` and `.dockerignore` and print a flyctl runbook. `--run` drives flyctl to completion. |
| `deploy railway [agent]` | Generate `Dockerfile` and `.dockerignore` and print a railway runbook. `--run` provisions an unlinked dir end to end; a linked one needs `--into-linked`. |
| `deploy agentcore [agent]` | Generate `agentcore.template.yaml`, `lambda/index.js` and image artifacts. `--run` builds and pushes an arm64 image, deploys the stack, registers webhooks, and stops the runtime session so the next call uses the new image. |
| `logs agentcore [agent]` | Tail the deployed Runtime's CloudWatch logs; `--source forwarder` selects the forwarder Lambda. `--since <duration>`, `--follow`. |
| `destroy agentcore [agent] [--run]` | Delete what `deploy agentcore` created: stack, artifact bucket, ECR repository, both log groups, pending wake alarms. Without `--run` it only lists them. A stack that does not reach `DELETE_COMPLETE` stops the rest. |
| `start [agent]` | Serve without watch. |

`deploy` writes artifacts and prints a runbook; only `--run` touches a host. Existing artifacts are kept unless
`--force`; a generated one that no longer matches the definition is flagged stale and gates `--run`. See
[Deploy](deploy.md).

## `fastagent init`

```bash
fastagent init <dir> [--content <source>]... [--no-install]
```

Creates the agent in `<dir>` itself, which must be new or empty: `APPEND_SYSTEM.md`, a `writing-great-skills`
example skill, `extensions/web-access.ts` (web search and page fetching from `@fastagent-sh/pi-web-access`, which
`package.json` depends on), `fastagent.config.ts`, `package.json`, `.secrets/.env.example`,
`.gitignore` and `.secrets/.gitignore`. It runs `npm install` unless `--no-install`, then makes the directory a git
repository whose first commit is the scaffold, so a change the agent makes to itself can be reviewed and undone. It
says when it does not: the directory is already inside a git repository that tracks it (one that ignores it, such as
a home directory kept in git with `*` ignored, does not count), git is not installed, or the commit failed for lack of
a `user.name`/`user.email` (the repository is kept; commit yourself). A deploy then ships the agent's `.git` with
it and installs `git` in the image ([what deploy bakes](deploy.md#what-deploy-bakes)).

Each `--content <source>` declares something the agent works on in `context.json` (see
[content](configuration.md#content)), read the way `content add` reads it:

| `<source>` | Declared | `content/<name>` here |
|---|---|---|
| `github:owner/repo` | `{ "github": "owner/repo" }` | A clone, made when the agent starts and brought up to date in place at each start |
| The root of a checkout whose `origin` is on GitHub | `{ "github": "owner/repo" }` | A link to the checkout |
| Any other directory, a subdirectory of such a checkout included | `{}` | A link to the directory; for a subdirectory, a note names the `github:` form, which is the whole repository |

The entry is named after the repository or the directory. A directory stays on this machine: a deployed instance works
without it, and `deploy` says so. A repository is cloned on a host. Every entry is checked before anything is
written: a directory must exist, and none may contain the agent directory or sit inside it. Without `--content` the
agent has none and works only in its own directory.

`init` refuses a directory that is not empty, inside a project as anywhere else, and names the command that creates
the agent elsewhere and attaches the project: `fastagent init <new directory> --content <project>`. It also refuses a
directory inside another agent. To deploy, keep the directory's name to letters, digits, `-` and `_`.

A `fastagent.config.ts` makes a directory an agent, whatever its name. Its contents may be `export default {}`.

## `fastagent info`

```bash
fastagent info [agent] [--json] [--model provider/modelId]
```

Prints, without serving:

- the agent directory, its content (`works on` / `knows`, each with its location), its environment (the tools and
  system packages `mise.toml` declares), config path, model and its source,
- the prompt (pi's default or `SYSTEM.md`, plus `APPEND_SYSTEM.md`),
- skills (each content entry's named `<content>/<skill>`) and their diagnostics,
- coding tools, authored tools and collisions,
- channels that import cleanly (a failing one is reported, and listed as `channelFailures` in `--json`),
- schedules with their next fire instant (a file that is not a valid schedule is reported),
- declared secrets, flagging any with no value here (`dev`/`start` refuse to boot without them),
- state, sessions and auth paths.

Content that cannot be resolved (its directory is missing, say), and a `mise.toml` FastAgent refuses, are reported,
not fatal; `info` installs nothing. `--json` carries `content`, `contentError`, `environment`, `environmentError` and
`contextFiles` (the agent directory's `AGENTS.md`, then each content entry's).
Read-only.

## `fastagent content`

```bash
fastagent content list [agent] [--json]
fastagent content add <source> [agent] [--readonly] [--ref <ref>] [--name <name>] [--description <text>]
fastagent content remove <name> [agent]
```

Edits `context.json` and the links in `content/`. `add` reads `<source>` the way `init --content` does: a
directory, the root of a GitHub checkout (declared as that repository, and linked to the checkout), or
`github:owner/repo` (cloned at the next start). A link is written absolute. `--readonly` makes it content the agent
knows rather than works on; `--ref` names a repository's branch, tag or commit; `--description` gives the agent one
sentence about it. An entry's name defaults to its directory's or repository's; `add` asks for `--name` when that
name is taken (ignoring case) or is not one segment of letters, digits, `-` and `_`, and refuses when something is
already at `content/<name>`. `remove` drops the entry and its link; the directory a link pointed to is untouched, and
so is a clone, which may hold the agent's work: `remove` says it is left, for you to delete.

Edits are made under a lock on `context.json`, so two at once apply one after the other, and a refusal leaves the
file and `content/` as they were. `list --json` prints each entry as every command resolves it, with its `notices`:
a checkout off its `ref`, a clone not made yet.

## `fastagent env`

```bash
fastagent env <mise args>
```

Runs the agent's own [mise](https://mise.jdx.dev) in the agent directory, the current one, on its `mise.toml` alone
([environment](configuration.md#environment-misetoml)). Everything after `env` goes to mise unchanged, `--help`
included; `fastagent help env` is this command's own help. It exits with mise's code.

```bash
fastagent env use gh@2                               # a CLI
fastagent env use npm:prettier@3                     # a CLI from npm
fastagent env bootstrap packages use apt:chromium    # a system package the image installs
fastagent env install                                # install what mise.toml declares
fastagent env ls
```

The first run adds mise to the agent's `package.json` (`npm install --save-optional --save-exact`, or `bun add`) and
says so. After mise exits, the file is read again: a change FastAgent would refuse at startup (`fastagent env set`
writes `[env]`) is reported at once and undone, `mise.toml` and `mise.lock` put back as they were before the command,
so it never reaches the next start. It refuses an agent whose `package.json` does not list `@fastagent-sh/fastagent`,
or that has none: mise would make it an agent with dependencies, whose image runs the FastAgent they list.

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
fastagent login [provider] [-g|--global] [--deployment <host>] [--no-input]
```

Writes to the selected environment's `auth.json` (default: `<agent dir>/.secrets/auth.json`; overrides:
`FASTAGENT_SECRETS_DIR`, `FASTAGENT_AUTH_PATH`). Local `start` recovery hints pin `FASTAGENT_AUTH_PATH` to the
credential file it uses, normally `.secrets/production/auth.json`. `-g`, or running outside any agent, writes
`~/.fastagent/.secrets/auth.json`. Inside an agent but not at its root, it refuses and says where to `cd`.

- An agent reads the global file for a provider it has no credential of its own for: no entry in its `auth.json`, no
  `apiKey` in its `models.json`, no env variable ([order](configuration.md#auth-and-secrets)). So one `login -g`
  serves every agent on the machine that has nothing else for that provider. A refresh is written back to the file
  it was read from. `login` warns when an env variable already authenticates the provider, because the global login
  is then not used.
- `--deployment <host>` logs this agent's deployment in instead: the login runs on the box (Docker, Fly, Railway,
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

Serves the agent locally. `SYSTEM.md`, `APPEND_SYSTEM.md`, its own and each content entry's `AGENTS.md`, skills and
prompt templates are re-read every turn. A supervisor restarts the
worker on edits to `tools/`, `channels/`, `fastagent.config.ts`, `package.json` and `.secrets/.env`,
once the turns running in it finish (at most 10 minutes, after which it restarts anyway and says it cut work off), so
an agent that edits its own `tools/` does not cut off the turn that made the edit.

With no model set and a terminal attached, commands that need one (`dev`, `start`, `invoke`,
`chat`, `deploy`) show the model catalog and write the pick to the config.

`--tunnel` opens a Cloudflare Quick Tunnel (needs `cloudflared`), prints the public URL, and registers webhooks
where it can; see [Local webhook development](channels.md#local-webhook-development).

## `fastagent chat`

```bash
fastagent chat [agent] [--model provider/modelId]
```

Opens the agent in pi's TUI with the definition's prompt files, its own and its content's `AGENTS.md`, skills, prompt
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

## `fastagent schedules list`

```bash
fastagent schedules list [agent] [--json]
```

Lists every schedule (`schedules/<name>.md`, see [Schedules](configuration.md#schedules)) with its next cron
instant, how its last run ended and the session its runs continue (`schedule:<name>`), then the agent's pending
wake-ups (id, next fire, one-shot or cron, session, prompt). `--json` adds each schedule's retained fire history
(the last 512):

| Outcome | Meaning |
|---|---|
| `completed` / `failed` | The turn finished, or failed. |
| `skipped` | The previous run was still going when this instant arrived. |
| `interrupted` | The process stopped mid-turn. The instant is not replayed; the next resident start records it. |
| `unreported` | Still running, or never settled (AgentCore has no resident start to record it). |

What a run said is in its session under `<state root>/sessions/`. A failure before the model was reached
(credentials, model) is only in the logs, under the host's retention. The agent cancels its own wake-ups with
`unwake({ id })`; as a last resort, edit `<state root>/schedule/wakeups.json`.

## `fastagent tool`

```bash
fastagent tool <name> '<json-args>' [agent]
```

Runs one tool directly, without a model or server. It gets the agent directory as `cwd` and the agent's content,
but no session.

```bash
fastagent tool reverse '{"text":"hello"}'
```

The result goes to stdout; stderr reports its size in model tokens. See
[Output budget](api-reference.md#output-budget).

## `fastagent add telegram|slack|feishu|lark`

```bash
fastagent add telegram [agent]
fastagent add slack [agent]    # create/install an internal app; --no-onboard scaffolds only
fastagent add feishu [agent]   # 飞书: scan-to-create the app
fastagent add lark [agent]     # Lark international: console + credential validation
                             # all channels take --env dev|production (default: dev)
                             # feishu/lark take --ingress websocket|webhook: writes the selected environment's setting
                             # (unset: dev connects by websocket, start and deployments receive by webhook)
                             # slack/feishu/lark take --no-onboard: write the files, skip the app onboarding
```

Writes `channels/<kind>.ts` (yours after that) and the channel's companion tools (`tools/<kind>-send.ts`, and
`tools/<kind>-threads.ts` for slack/feishu/lark; rewritten on every `add`), appends variables to
`.secrets/.env.example`, and writes generated secrets such as `TELEGRAM_SECRET_TOKEN` to `.secrets/.env`. Re-run
`add <kind>` (`--no-onboard` to skip the app onboarding) after upgrading the package to refresh the tools.
`--env production` selects `.secrets/production/.env` and `.state/production` without changing dev credentials.
Interactive `deploy --run` creates the separate Feishu/Lark production app automatically; Slack needs
`add slack --env production`, and Telegram needs a separate BotFather bot.

Slack:

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
state:    FASTAGENT_STATE_DIR   > <agent dir>/.state/production
secrets:  FASTAGENT_SECRETS_DIR > <agent dir>/.secrets/production
content:  <agent dir>/content/<name>
```

## Global options

Flags come after the command: `fastagent info --json`. `-h`/`--help` works on every command (also
`fastagent help <command>`); `-v`/`--version` comes before any command: `fastagent --version`.

| Option | Commands | Meaning |
|---|---|---|
| `--bind <addr>` | `dev`, `start` | Bind address: an IP literal or `localhost`. See [Bind address](configuration.md#bind-address). |
| `--no-invoke` | `dev`, `start` | Do not serve `POST /invoke` on this run, whatever the config says. For a `dev --tunnel` session whose only intended ingress is signed channel webhooks. |
| `--no-input` | `dev`, `start`, `invoke`, `login`, `deploy` | Never prompt; missing input is an error naming the flag to pass. |
| `--model <provider/modelId>` | assembly commands (not `deploy`) | Model for this run. `deploy` reads `FASTAGENT_MODEL` from `.secrets/production/.env`, then `config.model`. |
| `--json` | `info`, `schedules list`, `content list` | Machine-readable output. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including help and version). |
| `1` | Runtime failure: a failed turn, a broken definition, a deploy gate, an unknown tool name, invalid runtime configuration. |
| `2` | Usage error: unknown command or flag, missing or invalid arguments, conflicting flags. A mistyped command suggests the nearest one. |
