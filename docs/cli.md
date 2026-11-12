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

Each command's arguments, flags and examples are its help, `fastagent <command> --help`, which is generated from
the code and so always current. This page is the index, and the rules every command follows.

| Command | Purpose |
|---|---|
| `init <dir>` | Create an agent in a directory of its own; `--content` declares what it works on: a directory or a GitHub repository. |
| `info [agent]` | Show what an agent assembles into, without serving. |
| `build [agent]` | Compile the agent into `dist/`, the package an app or a host opens. |
| `content list\|add\|remove` | List, add or remove what the agent works on. |
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
| `add telegram\|slack\|feishu\|lark [agent]` | Scaffold a first-party channel: the channel file (if missing) and its tools, which is how an existing agent picks up a new tool. It changes the program only; the platform app is `channels setup`'s. |
| `add skill <source> [agent]` | Vendor an Agent Skills skill into `skills/`. |
| `channels setup <name> [agent]` | Set up one instance's platform app (`telegram`, `slack`): guide the person through creating it, check each pasted credential with the platform, and keep it in the instance's value file. `--ingress`, `--config` and `--env-file` say which instance it is and how it receives. |
| `channels setup <name> --record-url --config <file> (--env-file <file> \| --from-env) [--url <url>]` | Record, in the configuration a deploy delivers, the URL a person saved on a Slack or Lark app's page once the deployment's `/health` reports the channel reached there (`channels.<name>.app.url`; `--url` is where `/health` is read), so later deploys report it registered. |
| `secrets list\|set\|push <host> [agent]` | A deployment's values on the target that keeps them (`fly`, `railway`, `agentcore`; Docker holds none): the declared names and which the target holds, one value typed without echo or generated, or every declared value a file (`--env-file`) or the environment (`--from-env`) holds. |
| `deploy docker [agent]` | Generate `fastagent.<name>.compose.yml`, `Dockerfile` and `.dockerignore` for local Docker (one `agent` service, loopback port, `/data` volume). |
| `deploy fly [agent]` | Generate `fly.<name>.toml`, `Dockerfile` and `.dockerignore` and print a flyctl runbook. `--run` drives flyctl to completion. |
| `deploy railway [agent]` | Generate `Dockerfile` and `.dockerignore` and print a railway runbook. `--run` provisions an unlinked dir end to end and continues the project that holds the agent's service; a dir linked to another project needs `--into-linked`. |
| `deploy agentcore [agent]` | Generate `agentcore.<name>.template.yaml`, `agentcore/forwarder/index.js` and image artifacts. `--run` builds and pushes an arm64 image, deploys the stack, registers webhooks, and stops the runtime session so the next call uses the new image. `--idle-timeout <seconds>` (60–1209600) sets how long an idle session keeps its microVM, over the program's `defaults.deploy.agentcore.idleTimeoutSeconds`; the other hosts report it as ignored. |
| `deploy <host> --env-file <file>`, `--from-env` | The values to give the target: the file, and the environment the command runs in only with `--from-env` (a CI job's variables, `op run -- fastagent deploy … --from-env`), as for `secrets push`. A deployment has **no default value file** (not `.secrets/.env`, not `.secrets/production/.env`), and the shell alone is not a source. Docker's Compose always takes the environment it runs in. `logs`, `destroy` and `login --deployment` take `--env-file` for the host account (`AWS_PROFILE`, `AWS_REGION`), which they read from their environment as before. |
| `deploy <host> --config <file>` | Every host: deliver an instance configuration (a `fastagent.json`) the deployment runs on, set on the host as the variable `FASTAGENT_CONFIG_JSON` ([deploy](deploy.md)); the image holds none of it. Its `name` is the deployment's name: the host's resources and the generated manifests carry it ([deploy](deploy.md#an-instance-of-its-own)), and `secrets`, `logs`, `destroy` and `login --deployment` take the same `--config` to address it. Without it, the program's defaults; the project's own `fastagent.json` is never carried. |
| `logs agentcore [agent]` | Tail the deployed Runtime's CloudWatch logs; `--source forwarder` selects the forwarder Lambda. `--since <duration>`, `--follow`. |
| `destroy agentcore [agent] [--run]` | Delete what `deploy agentcore` created: stack, artifact bucket, ECR repository, both log groups, pending wake alarms. Without `--run` it only lists them. A stack that does not reach `DELETE_COMPLETE` stops the rest. |
| `start [agent]` | Serve without watch. |

`deploy` writes artifacts and prints a runbook; only `--run` touches a host. Existing artifacts are kept unless
`--force`; a generated one that no longer matches the definition is flagged stale and gates `--run`. See
[Deploy](deploy.md).

`deploy <host> --run --json` is a coding agent's deploy. What this machine can refuse (a missing value, a stale
artifact, a Lark app without its credentials) is answered at once; the deploy then runs in a process of its own, and
the command returns its ticket. `deploy <host> --check <ticket>` reads it, always as JSON: `working` with the `log`,
`need_user_action` for each step only the person can take (signing the host's CLI in, confirming a production
Feishu app, the box's model login), then `done` with the `url`, the Agent API's `notes` and what is left for the
person (`afterwards`: a channel whose Request URL only the console can set, say), or `failed` with why. Fly's
approval page can show a one-time code instead of finishing: `--check <ticket> --code <code>` hands it over. A second
`--run --json` while one runs answers with that one's ticket. `--timeout` (default 3600 s) bounds the person's steps,
never the host's work: a deploy is never cut halfway by it. One that hangs there ends on request,
`--check <ticket> --stop` (the report's `stop_command`), which can leave the host half-changed. Without `--json` and
without a terminal (CI), such a step stops the deploy, naming how to give it.

## Global options

Flags come after the command: `fastagent info --json`. `-h`/`--help` works on every command (also
`fastagent help <command>`); `-v`/`--version` comes before any command: `fastagent --version`.

| Option | Commands | Meaning |
|---|---|---|
| `--bind <addr>` | `dev`, `start` | Bind address: an IP literal or `localhost`. See [Bind address](configuration.md#bind-address). |
| `--no-input` | `dev`, `start`, `invoke`, `schedules run`, `login`, `logout`, `channels setup`, `deploy` | Never prompt; missing input is an error naming the flag to pass, and a person's step is handed back with a ticket. |
| `--model <provider/modelId>` | assembly commands (not `deploy`) | Model for this run. `deploy` has none: the model is the configuration's. |
| `--json` | `info`, `models`, `invoke`, `schedules list`, `content list`, `env list`, `login`, `auth check`, `add` | Machine-readable output. |

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
  (`channels setup`) work this way: a process of the CLI's own finishes the step and keeps a ticket that
  `--check <ticket>` reads. So does a whole deploy, opted into with `deploy <host> --run --json`: a deploy's exit 0
  says it is deployed, so one paused for a person (exit 0, `need_user_action`) is never what a CI job gets without
  asking for it.
- **A secret never passes through the agent's conversation.** The person pastes it on a page the command's own process
  serves, types it at a terminal of their own, or, for the values still left to a file (a model's API key, a bot
  token), writes it where the command names (the agent's `.secrets/.env`) in a terminal the agent does not read.
- **Results on stdout, everything else on stderr**: progress, notes, warnings and errors. A command whose result is
  data has `--json`.
- **The exit code says how it ended**: 0, 1 or 2, as above.
