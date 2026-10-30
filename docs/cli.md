---
title: CLI reference
description: "The fastagent CLI reference: init, info, content, env, models, login, logout, auth, dev, invoke, start, schedules, add, deploy, logs, and destroy, with their flags."
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
| `env add\|remove\|list\|install\|exec` | Add, remove or list the commands the agent runs: its environment. |
| `models [search]` | List the model specs the agent can name. |
| `login [provider]` | Sign in to a model provider (an account or an API key) into `<agent dir>/.secrets/auth.json`; `--deployment` logs the deployed box in. |
| `logout [provider]` | Remove a credential `login` stored. |
| `auth check` | Whether a provider is ready: `ready`, `not_ready` or `invalid`, for scripts and agents. |
| `dev [agent]` | Serve locally, restarting on code edits. |
| `invoke <message> [agent]` | Send one message, print its answer (`--json`: its events), and exit; `--session <id>` continues an earlier run's session. |
| `schedules list [agent] [--json]` | Every schedule (next instant, last run, session) plus pending wake-ups. |
| `schedules run <name> [agent]` | Fire one schedule now, as its clock would. |
| `schedules unwake <id> [agent]` | Cancel a pending wake-up, whatever session set it. |
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

Creates the agent in `<dir>` itself, which must be new or empty: `SYSTEM.md` (its system prompt), a
`writing-great-skills` example skill, `fastagent.config.ts`, `package.json` (FastAgent, and the exact pi-durable and
pi-ai versions this release is built with), `.secrets/.env.example`, `.gitignore` and `.secrets/.gitignore`. It runs `npm install` unless `--no-install`, then makes the directory a git
repository whose first commit is the scaffold, so a change the agent makes to itself can be reviewed and undone. It
says when it does not: the directory is already inside a git repository that tracks it (one that ignores it, such as
a home directory kept in git with `*` ignored, does not count), git is not installed, or the commit failed for lack of
a `user.name`/`user.email` (the repository is kept; commit yourself). A deploy then ships the agent's `.git` with
it and installs `git` in the image ([what deploy bakes](deploy.md#what-deploy-bakes)).

Each `--content <source>` adds something the agent works on (see [content](configuration.md#content)), read the
way `content add` reads it:

| `<source>` | In `context.json` (shared) | In `context.local.json` (this machine) | Here, the agent works in |
|---|---|---|---|
| `github:owner/repo` | `{ "github": "owner/repo" }` | Nothing | A clone at `content/<name>`, made when the agent starts and brought up to date in place at each start |
| The root of a checkout whose `origin` is on GitHub | `{ "github": "owner/repo" }` | `{ "path": "<checkout>" }` | The checkout |
| Any other directory, a subdirectory of such a checkout included | Nothing | `{ "path": "<dir>" }` | The directory; for a subdirectory, a note names the `github:` form, which is the whole repository |

The entry is named after the repository or the directory. A directory only this machine binds stays here: a deployed
instance works without it, and `deploy` says so. A repository is cloned on a host. Every entry is checked before
anything is written: a directory must exist, and none may contain the agent directory or sit inside it. Without
`--content` the agent has none and works only in its own directory.

`init` refuses a directory that is not empty, inside a project as anywhere else, and names the command that creates
the agent elsewhere and attaches the project: `fastagent init <new directory> --content <project>`. It also refuses a
directory inside another agent. To deploy, keep the directory's name to letters, digits, `-` and `_`.

A `fastagent.config.ts` makes a directory an agent, whatever its name. Its contents may be `export default {}`.

## `fastagent info`

```bash
fastagent info [agent] [--json] [--model provider/modelId]
```

Prints what the agent builds into, without serving it:

- the agent directory, its content (`works on` / `knows`, each with its location), its environment (the packages and
  apt packages `context.json` declares), the config path, and the model with its source (`--model`,
  `FASTAGENT_MODEL` or the config) and whether it resolves,
- its tools, extensions, skills and commands (prompt templates and `/skill:<name>`),
- its channels, each with how it is reached (webhook or long connection),
- its schedules with their next fire instant,
- the declared secrets (each with where it is declared and what it is for), flagging any with no value here: `dev`
  and `start` refuse to boot without them,
- state, secrets and auth paths.

A module that does not load, a schedule whose cron is not valid, or an environment FastAgent refuses makes `info`
fail as `dev` and `start` would, with the reason (exit 1). Content that cannot be resolved (a bound directory is
missing, say) is reported, not fatal. `info` installs and clones nothing. It writes nothing but the generated
`.fastagent/`, as every command that reads the definition does.

## `fastagent content`

```bash
fastagent content list [agent] [--json]
fastagent content add <source> [agent] [--readonly] [--ref <ref>] [--name <name>] [--description <text>]
fastagent content remove <name> [agent]
```

Edits `context.json` (what every instance reaches) and `context.local.json` (the directories of this machine the agent
is bound to). `add` reads `<source>` the way `init --content` does: a directory (bound here), the root of a GitHub
checkout (declared as that repository, and bound here to the checkout), or `github:owner/repo` (declared, and cloned
at the next start). A binding is written absolute. `--readonly` makes it content the agent knows rather than works
on; `--ref` names a repository's branch, tag or commit; `--description` gives the agent one sentence about it. An
entry's name defaults to its directory's or repository's; `add` asks for `--name` when that name is taken (ignoring
case) or is not one segment of letters, digits, `-` and `_`, and refuses a repository to clone when something is
already at `content/<name>`. `add` says when git would commit `context.local.json` (an agent made before `init`
ignored it). `remove` drops the entry from both files; the directory it was bound to is untouched, and so is a
clone, which may hold the agent's work: `remove` says it is left, for you to delete.

Edits take one lock, `context.json`'s (which `fastagent env` edits take too), so two at once apply one after the other
whichever files they write, and a refusal leaves both files as they were. `list` names a directory bound here that is
gone; `list --json` prints `{ content, absent }`: each entry as every command resolves it, with its `notices` (a
checkout off its `ref`, a clone not made yet), and each binding whose directory is gone.

## `fastagent env`

```bash
fastagent env add <packages...>       # name[@version], or apt:<name> for the image
fastagent env remove <packages...>
fastagent env list [--json]
fastagent env install
fastagent env exec -- <command...>
```

The agent's [environment](configuration.md#environment), in the agent directory, the current one: the `environment`
of its `context.json`, installed by the agent's own mise.

```bash
fastagent env add gh@2                          # a CLI from mise's registry
fastagent env add npm:prettier@3                # an npm package
fastagent env add python uv pypi:markitdown     # a PyPI package, with its runtime
fastagent env add apt:chromium                  # a Debian package the image installs
fastagent env exec -- gh --version
```

- **`add`** checks each package against the backend it resolves to, installs it here, and then writes `context.json`.
  A version defaults to `latest`; adding a declared package again replaces its version. An apt package is declared
  without installing anything; on Debian or Ubuntu, `add` says whether this machine has it.
- **`remove`** takes the names as declared (`gh`, `apt:chromium`), and runs no mise.
- **`list`** prints each package with its declared version, and each declared variable with whether it has a value
  here (never the value) and what it is for. It warns about what `deploy` would refuse (a refused backend, a PyPI
  package's undeclared runtime) and about a variable `dev` would refuse to start without. Variables are declared in
  `context.json` by hand: there is no command for them. `--json` prints `{packages: [{name, version}], apt: [name],
  variables: [{name, description, set}]}`, the warnings still on stderr.
- **`install`** installs mise (adding it to `package.json` when it is not there), then every declared package at the
  newest release its version allows, a newer one where one is out. Day to day it is not needed, since `add` installs
  what it adds and every start installs what is missing: it is for newer releases, and for a clone that has not
  installed its mise yet. It changes nothing in the agent directory, so a running `dev` keeps the releases it started
  with until it restarts, and says so.
- **`exec`** runs a command with the environment first on its `PATH` and the agent's `.secrets/.env` in its
  environment, tokens included, as the agent's own commands have them, and exits with its code. Every `env`
  subcommand reads `.secrets/.env` first, so a proxy declared there carries mise's downloads too.

A change installs before it writes `context.json`, so one that fails (a package mise cannot install, a refused backend)
or is interrupted (Ctrl-C) leaves it as it was. The write takes the lock content edits take, and applies the change to
`context.json` as it is by then, so two changes at once keep both. The first change adds mise to the agent's
`package.json` (`npm install --save-optional --save-exact`, or `bun add`) and says so; an agent whose `package.json`
does not list `@fastagent-sh/fastagent`, or that has none, is refused: mise would make it an agent with dependencies,
whose image runs the FastAgent they list.

## `fastagent models`

```bash
fastagent models [search] [-g|--global] [--refresh] [--json]
```

Lists the model specs (`provider/modelId`) the agent in the current directory can name, optionally filtered: pi-ai's
built-in providers with the models pi's published catalog adds to them ([model lists](configuration.md#model-lists)),
and the providers its `fastagent.config.ts` declares ([custom models](configuration.md#custom-models)). It needs none
of the secrets the agent declares. Outside an agent, or with `-g`, it lists the built-ins alone, without the agent's
providers. Inside an agent's subdirectory it refuses (as `login` does): `cd` to the agent, or pass `-g`.

`--json` prints the same list as an array of `{spec, provider, id, name}` (`name` is the model's display name, its
`id` when it has none), in the same order.

`--refresh` fetches the lists now, however recently they were fetched: for a model released in the last 4 hours. When
it cannot, `FASTAGENT_OFFLINE=1` included, it prints the lists it has, warns why, and exits 1.

## `fastagent login`

```bash
fastagent login [provider] [-g|--global] [--method account|api-key] [--json] [--timeout <seconds>]
                [--deployment <host>] [--no-input]
fastagent login --check <ticket> [--code <address>] [--json]
```

In a terminal it asks as pi's `/login` does: how to sign in (an account, an API key, or Radius), then the provider,
listed by name with what authenticates each one now (`✓ configured`, `✓ env: OPENAI_API_KEY`, `API key configured`,
`not configured`). `[provider]` is an id or a name (`openai`, `OpenAI`); for a provider that offers both ways it asks
which, in its own words (`Sign in with ChatGPT`). `openai-codex` is listed as pi lists it, `OpenAI Codex (legacy)`:
a ChatGPT account signs in to `openai`. When the agent has no model, `login` prints the line that would give it pi's
default for the provider (`model: "openai/gpt-5.5"`); it never edits `fastagent.config.ts`.

Without a terminal, or with `--no-input` or `--json`, a script or a coding agent signs in, and nothing is asked or
waited on. A coding agent works in turns, so each command does its part and says what comes next, as Netlify's
`login --request`/`--check` and Dosu's login tickets do. With `--json` the outcome is one object on stdout, whose
`agent_next_steps` says it in a sentence:

- **A choice not given** (no `[provider]`, or no `--method` for a provider that offers both) exits 2 with
  `"status": "need_choice"` and the `choices`, each with the `command` that makes it.
- **An account** (`--method account`) starts its sign-in in a process of its own and returns at once, exit 0, with
  `"status": "need_user_action"`: the `url` for the person to sign in at (and the `code` to enter there, for a device
  sign-in), a `ticket`, `check_command` and `expires_in`. No browser is opened: the agent hands the address to its
  person, who may be on another machine. `fastagent login --check <ticket>` then answers `need_user_action` (not
  finished), `working` (fastagent is at it: nothing for the person now), `done` (with the `path` it was saved to, and
  the default `model` for an agent with none), `failed` or `expired`; every answer carries `provider` and
  `"method": "account"`. When the person's browser cannot reach this machine, it ends on a page that does not load
  (an address on localhost): `resume_command`, `login --check <ticket> --code '<that address>'`, hands it to the
  sign-in. `--timeout` sets how long the sign-in stays open (default 600 seconds). A newer sign-in to the same
  provider stops one still waiting on the person (its ticket is then `failed`, "replaced by a newer attempt to sign in
  to <provider>"), which would otherwise hold the provider's callback port until it expired; one already exchanging
  the code is never stopped, and the newer attempt answers with its ticket. A ticket belongs to the command that
  started it: `--check` with another command's ticket exits 2 naming the right one.
- **An API key** (`--method api-key`) is the person's to set where the agent reads it, never typed into the agent's
  conversation: `"status": "need_user_action"` names the `variables` the provider reads (`OPENAI_API_KEY`) and the
  agent's `value_file` (`.secrets/.env`), and `check_command` is `fastagent auth check`. When one is set already, the
  answer is `"status": "ready"`. An account sign-in stored for the provider outranks a key in the environment, so then
  `logout_command` comes first. With no agent's value file to name (`-g`, or no agent here), the person runs
  `terminal_command`, `login <provider> --method api-key -g`, in a terminal of their own: a variable set now would never
  reach the agent's environment, fixed when it started.
- Exit status: 0 signed in, or waiting on the person; 1 cancelled, failed or expired; 2 a provider or method not
  given, or a ticket that is not one.

Writes to the selected environment's `auth.json` (default: `<agent dir>/.secrets/auth.json`; overrides:
`FASTAGENT_SECRETS_DIR`, `FASTAGENT_AUTH_PATH`). Local `start` recovery hints pin `FASTAGENT_AUTH_PATH` to the
credential file it uses, normally `.secrets/production/auth.json`. `-g`, or running outside any agent, writes
`~/.fastagent/.secrets/auth.json`. Inside an agent but not at its root, it refuses and says where to `cd`.

- An agent reads the global file for a provider it has no credential of its own for: no entry in its `auth.json`, no
  provider in its config that authenticates itself, no env variable ([order](configuration.md#auth-and-secrets)). So one `login -g`
  serves every agent on the machine that has nothing else for that provider. A refresh is written back to the file
  it was read from. `login` warns when an env variable already authenticates the provider, because the global login
  is then not used.
- `--deployment <host>` logs this agent's deployment in instead: the login runs on the box (Docker, Fly, Railway,
  AgentCore) and the credential stays there. `deploy` never carries `auth.json`. Without a terminal, an account's
  sign-in returns a ticket as a local one does (`deployment` names the host), its process holding the box's shell
  until the box answers; an API key is named for the person to set in `.secrets/production/.env`, which the next
  `deploy <host> --run` carries. See [Logging a deployment in](deploy.md#logging-a-deployment-in).
- Several processes can share one `auth.json` safely (OAuth refresh is locked). Do not copy an OAuth `auth.json`:
  each copy rotates the single-use refresh token and breaks the other.
- An API-key login is checked with one request to pi's default model for the provider, before the key is written.
  A 401 is never stored, so the file keeps what it held, and the key is asked for again; other failures keep the
  key and print the provider's message. Inside an agent the check goes to the endpoint its config's provider names (a
  gateway in front of a built-in provider, say); with `-g` it goes to the provider's own endpoint.
- `auth.json` is always written `0600`. `.secrets/.env` is `0600` only when fastagent creates it; directories keep
  the permissions you gave them.

## `fastagent logout`

```bash
fastagent logout [provider] [-g|--global] [--no-input]
```

Removes the credential `login` stored for a provider, from the file `login` writes, as pi's `/logout` does: in a
terminal, a menu of the providers stored there; otherwise the one named (an id or a name), which must be stored there
(exit 1 names what is), and none named exits 2. Environment variables, and the grant at the provider, are left as
they are.

## `fastagent auth check`

```bash
fastagent auth check (--provider <id> | --model <provider/modelId>) [-g|--global] [--json]
```

Whether a provider is ready for the agent here, as pi's `auth check` answers it: prints `ready`, `not_ready` or
`invalid` and exits 0, 1 or 2. The answer is the one the agent's messages would get: its credentials file over the
global one, then the environment, with a login due a refresh refreshed. `--json` prints one object:

| Status | Fields |
|---|---|
| `ready` | `provider`, `authType` (`oauth` or `api_key`), `source` (`OAuth`, `stored credential`, or the variable), `path` |
| `not_ready` | `provider`, `reason`: `provider_not_found` or `credentials_not_configured`, `path` |
| `invalid` | `provider`, `reason: "invalid_state"`, `error` (a corrupt entry, a refresh the provider refused), `path` |

## `fastagent dev`

```bash
fastagent dev [agent] [--port N] [--bind addr] [--model provider/modelId] [--no-watch] [--tunnel] [--no-input]
```

Serves the agent locally: its channels, schedules and wake-ups. `SYSTEM.md`, `AGENTS.md`, `skills/` and `prompts/` are
read for every message. A supervisor restarts the worker on edits to `src/`, `fastagent.config.ts`, `package.json` and
`.secrets/.env`, once the messages running in it finish (at most 10 minutes, after which it restarts anyway and says it
cut work off), so an agent that edits its own code does not cut off the message that made the edit. A helper imported
from outside `src/` is not watched: restart `dev` after editing one.

The instance's storage (`<state root>/agent.sqlite`) is held by one process at a time: a second `dev` or `start` of the
same agent is refused, naming the file.

With no model set and a terminal attached, commands that need one (`dev`, `start`, `invoke`, `deploy`) show the model
catalog and use the pick for this run, printing the line to put in the config.

`--tunnel` opens a Cloudflare Quick Tunnel (needs `cloudflared`), prints the public URL, and registers webhooks
where it can; see [Local webhook development](channels.md#local-webhook-development).

## `fastagent invoke`

```bash
fastagent invoke <message> [agent] [--model provider/modelId] [--no-input] [--json] [--session <id>]
fastagent invoke <message> [agent] --url <base> [--key <key>] [--model provider/modelId] [--json] [--session <id>]
```

Sends one message and exits: the answer text to stdout, tool and diagnostic lines to stderr, and a non-zero exit
unless the message completed. This is the check a coding agent runs: one message, its answer, and an exit code.

- **`--json`** prints JSON lines on stdout instead: the message's events as the
  [Agent API](SPEC.md) §6.2 delivers them, first `{"type": "message", "message"}` as it was recorded,
  then `entry`, `delta`, `tool_started`, ..., ending with its `done`. A message that ends another way ends with the
  line that says why: `{"type": "rejected", "error"}` when the agent refused it, a `stream_error` event, or
  `{"type": "unfinished", "reason"}`. The exit code is the same as without `--json`.
- **`--session <id>`** sends the message into a session an earlier run created, continuing it. Every run prints its
  session's id on stderr (`[fastagent] session <id> …`), and `--json`'s first line carries it as `sessionId`; without
  `--session`, a run starts a new session. Each run answers with the model it resolves (`--model`,
  `FASTAGENT_MODEL`, the config), a continued session included.

**`--url <base>`** sends the message to the agent served at `<base>` instead, over its
[Agent API](SPEC.md#9-http): the same output, `--json`, `--session` and exit code, nothing opened here. It
calls with `--key`, or the first key of `FASTAGENT_API_KEY` in the agent's `.secrets/production/.env`, which `deploy`
writes; with neither, it exits 2 and says where a key comes from. `--model` sets that session's model on the
deployment; without it, the deployment's default answers. A coding agent that checked the agent with `invoke` checks
its deployment with `invoke --url`, the URL `deploy` reports.

`invoke` keeps its sessions in `<stateRoot>/invoke.sqlite`, never the instance's storage, so it runs beside a `dev`
or `start` of the same agent. One `invoke` of an agent runs at a time: a second one while the first runs is refused.
A message whose `invoke` was stopped (Ctrl-C, a timeout) is not run again: the next `invoke` ends it, aborted, and
says so on stderr. It has no `wake` tool, since no clock fires for its sessions. The file keeps every session it was
given and grows with them; delete it, while no `invoke` runs, to start from none.

## `fastagent schedules list`

```bash
fastagent schedules list [agent] [--json]
```

Lists every schedule (`src/schedules/<name>.ts`, see [Schedules](configuration.md#schedules)) with its next cron
instant, how its last run ended and the session its runs continue, then the agent's pending wake-ups (id, next fire,
one-shot or cron, session, prompt). `--json` adds each schedule's retained fire history (the last 512):

| Outcome | Meaning |
|---|---|
| `completed` / `failed` | The message finished, or failed. |
| `skipped` | The previous run was still going when this instant arrived. |
| `interrupted` | The process stopped after claiming the instant and before sending its message. The instant is not replayed. |
| `unreported` | Still running, or not settled yet: the next start settles it from what became of its message. |

What the agent said is in the schedule's session, in the instance's storage. A failure before the model was reached
(credentials, model) is only in the logs, under the host's retention.

## `fastagent schedules run`

```bash
fastagent schedules run <name> [agent] [--model provider/modelId] [--no-input]
```

Fires the schedule `<name>` now, the way its clock would: in the schedule's own session, with its claim and its
outcome recorded, so `schedules list` shows the fire. A fire a stopped serve claimed and never reported is settled
first, as a serve's start settles it. The answer goes to stdout and the fire's log to stderr; the exit is non-zero
unless its message completed, as `invoke`'s: a cut-off answer (`incomplete`) exits 1, though the claim records it
`completed`. `--model` is the default model, as for `dev`: a schedule's session takes it at its first fire and keeps
it after that.

It opens the instance's storage, so it is refused while `dev` or `start` serves the agent, and they are refused while
it runs. It is refused too while the storage holds messages a stopped serve left unfinished: it would run them, with
no channel to deliver their answers, and cut them off when it exits. `dev` runs them on; stop it once they end. It
fires a schedule of this machine's instance; a deployed one keeps its own state.

## `fastagent schedules unwake`

```bash
fastagent schedules unwake <id> [agent]
```

Cancels the pending wake-up `<id>` (`schedules list` shows the ids), whatever session set it. The agent cancels its
own with `unwake({ id })` from the session that set them; this command is the way to one set where nobody can message
the agent, such as during a schedule's fire, in the schedule's own session. A serve's clock writes the same store, so
it is refused while `dev` or `start` serves the agent.

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
                             # --json: the outcome as one JSON object; without a terminal, the person's part
                             # comes back as need_user_action and a ticket (below)
```

Writes `src/channels/<kind>.ts` (yours after that) and the channel's companion tools (`src/tools/<kind>-send.ts`, and
`src/tools/<kind>-threads.ts` for slack/feishu/lark; rewritten on every `add`), appends variables to
`.secrets/.env.example`, and writes generated secrets such as `TELEGRAM_SECRET_TOKEN` to `.secrets/.env`. Re-run
`add <kind>` (`--no-onboard` to skip the app onboarding) after upgrading the package to refresh the tools.
`--env production` selects `.secrets/production/.env` and `.state/production` without changing dev credentials.
Interactive `deploy --run` creates the separate Feishu/Lark production app automatically (without a terminal it names
`add <kind> --env production --json`); Slack needs
`add slack --env production`, and Telegram needs a separate BotFather bot.

Slack:

- Onboarding creates the app through `apps.manifest.create`, installs it through OAuth, and writes the bot token
  and signing secret to `.secrets/.env`. The App Configuration token stays in `<state root>/channels/slack/` on
  this machine; `dev --tunnel` and `deploy --run` use it to update the Request URL.
- `--replace-config` replaces that token pair when it has expired or been revoked. Other machines set the Request
  URL in the Slack console.

Without a terminal, or with `--json` or `--no-input`, the app's setup is driven by a coding agent and finished by its
user ([Scripts and coding agents](#scripts-and-coding-agents)):

| Channel | What the person provides first | What the ticket waits on |
|---|---|---|
| `feishu` | nothing | confirming the new app (`url`, in a browser or in Feishu) |
| `lark` | `LARK_APP_ID` and `LARK_APP_SECRET`, from the app they create at `url`, in the selected environment's file (`value_file`: `.secrets/.env`, or `.secrets/production/.env` with `--env production`) | nothing; the setup verifies the app and captures its Verification Token |
| `slack` | nothing | pasting an App Configuration token pair on the page at `url`, which then takes the browser on to Slack's install page to click Allow |

Slack's page is the setup's own, served through the temporary tunnel `add slack` opens anyway, at a one-time random
address. The pair never passes through the agent's conversation or any `.env` file: it manages every Slack app the
person owns in that workspace, and only this machine's CLI uses it, so it goes into the onboarding state (`0600`) and
never deploys.

A missing first part answers `need_user_action` naming it, with the command to run again (`check_command`). Then the
setup runs in a process of its own and the command returns its ticket: `need_user_action` while the person has a
step, `working` while there is nothing for them to do, then `done` with the variables it `written`, the
`next_steps` and the steps left to the person (`afterwards`, such as publishing a version). `add <kind> --check
<ticket>` reads where it stands, `--timeout <seconds>` sets how long it stays open (default 900). Running `add` again
for the same agent, channel and environment replaces a setup waiting on the person, and answers with one at work. A
value the setup still needs (a Lark Verification Token it could not capture) fails the ticket naming the variable to
set before running it again.

See [Telegram](telegram.md), [Slack](slack.md), [Feishu (Lark compatibility)](feishu.md).

## `fastagent add skill`

```bash
fastagent add skill <source> [agent] [--update]
```

Vendors a skill into the agent's `skills/<name>/`. `<source>` is a GitHub-style ref, a local path, or a bare name
from the machine's skill directories. `--update` overwrites an existing one.

## `fastagent start`

```bash
fastagent start [agent] [--port N] [--bind addr] [--model provider/modelId] [--tunnel] [--no-input]
```

Serves without watching. Binds all interfaces by default. A serve answers its channels' routes, `GET /health`, and
the Agent API under `/v1` when `FASTAGENT_API_KEY` holds a key and the definition does not say `http: { api: false }`;
the startup report says whether it does, and why not
([Configuration](configuration.md#the-agent-api-over-http)).

```txt
port:     --port > PORT > fastagent.config.ts http.port > 8787
bind:     --bind > all interfaces
state:    FASTAGENT_STATE_DIR   > <agent dir>/.state/production    (agent.sqlite, channel and schedule state)
secrets:  FASTAGENT_SECRETS_DIR > <agent dir>/.secrets/production
content:  <agent dir>/content/<name> (clones; a host has no context.local.json)
```

## Global options

Flags come after the command: `fastagent info --json`. `-h`/`--help` works on every command (also
`fastagent help <command>`); `-v`/`--version` comes before any command: `fastagent --version`.

| Option | Commands | Meaning |
|---|---|---|
| `--bind <addr>` | `dev`, `start` | Bind address: an IP literal or `localhost`. See [Bind address](configuration.md#bind-address). |
| `--no-input` | `dev`, `start`, `invoke`, `schedules run`, `login`, `logout`, `deploy` | Never prompt; missing input is an error naming the flag to pass. |
| `--model <provider/modelId>` | assembly commands (not `deploy`) | Model for this run. `deploy` reads `FASTAGENT_MODEL` from `.secrets/production/.env`, then `config.model`. |
| `--json` | `info`, `models`, `invoke`, `schedules list`, `content list`, `env list`, `login`, `auth check` | Machine-readable output. |

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
- **A step only a person can take returns at once**, with what the person does and how to follow it:
  `"status": "need_user_action"`, the address to open, and a `check_command` to run once they have, in a sentence for
  the agent (`agent_next_steps`). An account sign-in (`login`, and `login --deployment` on the box) and an app's setup
  (`add slack|feishu|lark`) work this way: a process of the CLI's own finishes the step and keeps a ticket that
  `--check <ticket>` reads. `deploy --run` without a terminal names the command that hands its person's part over:
  `add <kind> --env production --json` for a production app, `login <provider> --method account --deployment <host>
  --json` for the box's model login.
- **A secret never passes through the agent's conversation.** The person writes it where the command names (the
  agent's `.secrets/.env`), pastes it on a page the command's own process serves, or types it at a terminal of their
  own.
- **Results on stdout, everything else on stderr**: progress, notes, warnings and errors. A command whose result is
  data has `--json`.
- **The exit code says how it ended**: 0, 1 or 2, as above.
