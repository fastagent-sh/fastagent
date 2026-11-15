---
title: Deploy
description: "Ship an agent to local Docker, Fly.io or Railway: one command, the values it needs, channels, logins, and what each host keeps."
status: current
---

# Deploy

```bash
fastagent deploy fly --run --env-file prod.env    # or docker, railway
```

Without `--run`, `deploy` only writes the files (a `Dockerfile` and the host's manifest) and prints the steps. With
`--run` it does them with the host's CLI. It builds `dist/` first, so a type error stops it before anything ships.

| Host | You need | State |
|---|---|---|
| [Docker](#local-docker) | Docker Compose ≥ 2.3.3 | a volume at `/data` |
| [Fly.io](#flyio) | `flyctl` | a volume at `/data` |
| [Railway](#railway) | Railway CLI 5.x | a volume at `/data` |

## Before you deploy

1. **Try the production build here:** `fastagent build && fastagent start --root $(mktemp -d) --env-file prod.env`.
   `fastagent deploy docker --run` runs the real image on your machine.
2. **Set a model** in the configuration (`defaults.model`, or `model` in the file `--config` names). `deploy` ignores
   `FASTAGENT_MODEL` and `--model`.
3. **Give it its values.** A deployment reads no file by default: pass `--env-file <file>`, or `--from-env` to take
   them from the environment (`op run -- fastagent deploy fly --run --from-env`). `--run` stops before building when
   the target lacks a declared name, and at a terminal offers to set it. Set values any time with
   `fastagent secrets push|set <host>`.
4. **Make something reach it**: a channel, a schedule, or the [Agent API](#the-agent-api).

A coding agent deploys with `--run --json`: when prerequisites (host auth, channel credentials, target secrets) are in
place it deploys synchronously and prints the JSON outcome; if an interactive step is missing, it stops immediately naming
what the user must run in a terminal (`fly auth login`, `fastagent channels setup`, `fastagent secrets set`, or
`fastagent login --deployment`).

## Several instances

A deployment is named by the `name` in its `--config` file, else by the program. Each gets its own host resources and
its own manifest (`fly.<name>.toml`, `fastagent.<name>.compose.yml`); the image is shared.

```bash
fastagent deploy fly --run --config acme.json      # { "name": "acme" }
fastagent deploy fly --run --config globex.json    # { "name": "globex" }
```

`secrets` and `login --deployment` take the same `--config` to pick the instance.

- The configuration is set on the host as `FASTAGENT_CONFIG_JSON`. After changing it, run `deploy <host> --force`
  (Docker, Fly) or `--run` again (Railway).
- Your project's own `fastagent.json` is never deployed.
- A deployed configuration cannot hold a local directory, instance `skills`/`prompts`/`instructions`, a relative MCP
  `command`, or a literal secret. Write `${NAME}` and set the value with `fastagent secrets set <host> <NAME>`.

## The Agent API

Docker, Fly and Railway serve the [Agent API](agent-api.md#over-http) under `/v1`, behind `FASTAGENT_API_KEY`. When the target
has no key, `--run` at a terminal makes one and prints it once. Without a terminal it stops and names
`fastagent secrets set <host> FASTAGENT_API_KEY --generate`. Check it:

```bash
fastagent invoke --url https://<app>.fly.dev "hello"
```

Rotate a key with `FASTAGENT_API_KEY=new,old`, move the callers, then drop `old`. `http: { api: false }` turns the API
off.

## Chat channels

- **Webhooks point themselves.** On Fly and Railway the box points Telegram, Feishu and Lark at its own URL
  on every start. Slack's Request URL is yours to set: `--run` prints it, and at a terminal with `--config` records it in that file
  once Slack reaches it.
- **Use separate production apps.** Two instances on one bot split its messages. Run
  `fastagent channels setup <name> --config prod.json --env-file prod.env` for the production app. Interactive `--run`
  creates a missing Feishu/Lark production app itself.
- **Feishu/Lark receive by webhook** when deployed, unless the configuration sets
  `channels.<name>.ingress: "connection"`.
- **Docker has no public URL.** Put your own ingress in front, and set it as `http.publicUrl`, or use a channel's
  connection mode.

## Logging a deployment in

A model with no API key on the target (a ChatGPT account, say) signs in on the box itself:

```bash
fastagent login openai --deployment fly
```

The prompts show here and the browser opens here; the credential stays on the box. `deploy --run` does this once the
box is up, when the box has no credential yet; a redeploy keeps it. Without a terminal (CI), `--run` stops at that step:
use an API key for unattended deploys. A login on the box outranks a key set later; `login --deployment` again to
switch.

## Local Docker

```bash
fastagent deploy docker --run
```

Writes `Dockerfile`, `.dockerignore` and `fastagent.<name>.compose.yml`: one `agent` service on `127.0.0.1:<port>`,
a volume at `/data`, and each secret **by name only**, filled from the environment that runs Compose. `--run` checks
those names are set, builds, starts, and waits for `/health`.

```bash
docker compose -f fastagent.<name>.compose.yml logs -f agent
docker compose -f fastagent.<name>.compose.yml down      # keeps the volume; -v deletes it
```

Edit the generated files freely: a file is regenerated by `--force` only while it keeps its first marker line.

## Fly.io

```bash
fastagent deploy fly --run
```

Creates the app and its IPs, sets the values, deploys, and checks `/health` and the webhooks. It is safe to re-run.
Signs you in with `fly auth login` when needed. Idle machines suspend (`min_machines_running = 0`) unless the agent
must stay up ([scale to zero](#scale-to-zero)).

## Railway

```bash
fastagent deploy railway --run
```

Creates the project, service, volume, variables and domain, uploads, and checks `/health`. A directory linked to
another Railway project is refused unless you pass `--into-linked`.

## Scale to zero

| The agent has | Fly / Railway |
|---|---|
| a schedule | stays up: nothing would wake it on time |
| a long-connection channel | stays up |
| neither | may scale to zero |

Wake-ups do not keep a machine up: a stopped machine runs what is due when a request next wakes it. To run on a clock
and still scale to zero, have an outside cron call a channel of your own or the Agent API.

## What ships

The image holds the agent directory (at `/app`) minus `.secrets/`, `.state/`, `content/`, `node_modules`, `.env*` and
the file `--env-file` names. It installs `git` when the agent is a repository or clones GitHub content. The persistent
root holds what changes:

```text
/data/
├── .state/           # sessions, channel and schedule state
├── .secrets/         # the box's own login
├── content/          # clones of github content
└── .deployment/      # lock and release record: do not delete
```

A new release replaces the image; the root stays. Run **one replica** per instance: a second process is refused.
The generated `Dockerfile` runs on any other container host too: give it a volume, the variables, and a public URL for
webhooks.
