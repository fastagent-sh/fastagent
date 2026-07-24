---
title: Deploy
description: "Ship the directory: local Docker Compose, Fly.io, Railway, portable containers, secrets, persistent state, and scale-to-zero behavior."
status: current
---

# Deploy

FastAgent has **no application build step** — the directory is the deployable unit. Deployment is: copy the workspace to a host with Node >= 22.19 (or Bun), install dependencies, and run `fastagent start`. The `deploy` command wraps that for a target: it generates a definition-aware container recipe plus target config and prints an ordered runbook. `--run` drives the target CLI instead of handing you the runbook.

```bash
fastagent deploy docker                 # Dockerfile + local Compose + runbook
fastagent deploy docker --tunnel        # generate Compose with a Quick Tunnel service
fastagent deploy docker --run           # start the app service
fastagent deploy docker --tunnel --run  # start app+tunnel and register webhooks
fastagent deploy fly           # Dockerfile + fly.toml + runbook
fastagent deploy fly --run
fastagent deploy railway
fastagent deploy railway --run
```

FastAgent generates only what it can know from the definition: image shape, state root, exact secret names, channel paths, and target-specific runtime settings. Local Docker can opt into an ephemeral Cloudflare Quick Tunnel; durable ingress, reverse proxies, DNS, and TLS remain operator-owned. Generation and execution stay separate: `--tunnel` shapes Compose, while `--run` is the only flag that starts Docker.

## Before you deploy

Three things must be true, or the deployed box crash-loops on boot:

| Requirement | Why | How |
|---|---|---|
| **Model is in `fastagent.config.*`** | A `--model` flag, `FASTAGENT_MODEL`, or `.env` value is builder-local and does **not** travel (`.env` is dockerignored). Only the config file ships. | `model: "provider/id"` in `fastagent.config.mjs`. `deploy` warns (or, under `--run`, gates) if it's missing. |
| **Secrets are declared** | The host needs the model API key and every channel's verification secret. | Env-key model auth + channel secrets are auto-listed; declare anything else in `config.deploy.secrets` (see [Configuration](configuration.md)). |
| **State goes on a volume** | Sessions and channel state live under `.state/`, the seeded/rotated `auth.json` under `.secrets/`; a redeploy that replaces the directory wipes them otherwise. | Every generated target mounts a volume at `/data` and sets `FASTAGENT_STATE_DIR=/data/.state` + `FASTAGENT_SECRETS_DIR=/data/.secrets`. |

Model auth: if your local auth is an **env key** (e.g. `OPENAI_API_KEY`), `deploy` lists it as a host secret automatically. In a runbook-only deploy, an OAuth/stored login still needs a provider API key or an `auth.json` placed on the volume. Under `--run`, FastAgent carries the local auth file as an absent-only `FASTAGENT_AUTH_SEED`, so a credential already refreshed on the volume is never overwritten.

## Local Docker

Prerequisite: Docker Engine/Desktop with Docker Compose 2.3.3 or newer (`docker compose version`).

```bash
fastagent deploy docker
```

For a flat workspace this generates `Dockerfile`, `.dockerignore`, and `fastagent.compose.yml`. The Compose file contains one `agent` service:

- the generated or user-owned Dockerfile,
- `127.0.0.1:<port>` for safe host-local access,
- a named volume mounted at `/data`,
- `FASTAGENT_STATE_DIR=/data`, `PORT`, and the exact model/channel/extra secret names,
- `restart: unless-stopped`.

By default it contains no public ingress. If a webhook channel needs a temporary public URL, generate an independent cloudflared service alongside the app:

```bash
fastagent deploy docker --tunnel
```

This still only writes files. The FastAgent Dockerfile remains unchanged; Compose adds a pinned `cloudflare/cloudflared` image pointing at the Docker-internal `http://agent:<port>`. The tunnel service prepends `agent,localhost,127.0.0.1` to both `NO_PROXY` forms so Docker Desktop's injected proxy cannot intercept origin traffic; webhook registration still honors the host's `HTTPS_PROXY`. Start immediately or later — the existing Compose file remains authoritative:

```bash
fastagent deploy docker --tunnel --run  # generate + start
# or, after generation:
fastagent deploy docker --run           # starts the existing app+tunnel topology
```

`--run` checks Docker/Compose and the daemon, gates missing credentials/secrets before building, runs `docker compose up -d --build`, verifies the configured services, and waits for the app's `/health` when a host port is published. With a `tunnel` service, it then reads the assigned `*.trycloudflare.com` URL from Compose logs and reuses the same webhook registration as `dev --tunnel`: route-based Telegram, locally onboarded Slack, and Feishu/Lark register automatically; WebSocket long-connection channels are skipped; GitHub and scaffold-only/manual Slack print their console URLs. API-key and channel values travel through the child environment, not argv; OAuth/stored auth travels through `FASTAGENT_AUTH_SEED` into the state volume.

The Quick Tunnel URL is ephemeral. Its service deliberately has no restart policy: restarting that container or the Docker daemon creates a new URL that cannot silently replace the old webhook. Re-run `fastagent deploy docker --tunnel --run` to start it and register the new URL. For a fixed/restart-stable endpoint, edit the user-owned Compose topology to use your own named tunnel or reverse proxy.

Operate the generated topology:

```bash
docker compose -f fastagent.compose.yml logs -f agent
docker compose -f fastagent.compose.yml ps
docker compose -f fastagent.compose.yml down     # state volume is kept
docker compose -f fastagent.compose.yml down -v  # destructive: deletes all state
```

### Taking ownership of Docker files

Generated files are defaults, not a second source of truth:

- An existing `Dockerfile`, `.dockerignore`, or `fastagent.compose.yml` is kept byte-for-byte and used by `--run`.
- Editing a generated Dockerfile or Compose file may produce a drift warning, but never an automatic rewrite. Remove its first generated-marker line to suppress that classification after taking ownership.
- `--force` is the explicit destructive opt-in to regenerate artifacts, including hand-owned ones.
- To regenerate only one artifact while preserving the others, delete that file and rerun without `--force`.
- `--tunnel` only shapes a newly generated/forced Compose file. If an existing authoritative file has no `tunnel` service, `--tunnel --run` gates before Docker side effects and tells you to edit, delete/regenerate, or use `--force`.
- A custom Dockerfile owns system packages/base-image details; `config.deploy.apt` only shapes the generated Dockerfile.

The `agent` service name is the small contract used by `--run`; the optional generated service is named `tunnel`. Add other sidecars, networks, volumes, or custom ports freely. If you remove the host port, `--run` accepts the running app and uses the Compose ingress readiness floor.

## Fly.io

Prereqs: [flyctl](https://fly.io/docs/flyctl/install) installed and `fly auth login`.

```bash
fastagent deploy fly
```

Generates `fly.toml`, `Dockerfile`, `.dockerignore`, then prints a first-deploy runbook:

1. `fly apps create <name>` — one-time (Fly app names are globally unique; if taken, edit `app` in `fly.toml` and re-run `deploy`).
2. `fly volumes create data --region <region> --size 1` — one-time; the region **must** match `primary_region` in `fly.toml`.
3. `fly secrets set …` — the model key + each channel's secrets, with `<value>` placeholders to fill.
4. `fly deploy` — build and ship. **A redeploy is this step alone.**
5. Register each route channel's webhook at the live URL. Locally onboarded Slack updates its App Manifest from the builder machine; scaffold-only/manual Slack prints the console URL. WebSocket long-connection channels make no registration call.

Or let the CLI do all of it:

```bash
fastagent deploy fly --run   # idempotent, resumable; carries your local env secrets to Fly
```

Idle behavior defaults to **suspend** (snapshot + fast resume on the next webhook, ~hundreds of ms). Flags: `--stop` (cold-stop instead of suspend), `--no-scale-to-zero` (keep one machine always up), `--force` (overwrite artifacts). A GitHub channel forces one machine to stay up because its fire-and-forget turns have no replay. A long-connection channel also forces one machine up because its outbound connection cannot wake a stopped machine.

**Time triggers and long-connection channels keep one machine running.** Cron/wake has no inbound request at its firing instant; an outbound WebSocket similarly cannot wake from zero. Pre-flight detects long connections structurally, including custom channels, and generated Fly config forces `min_machines_running = 1` (Railway forbids App Sleeping). If a kept `fly.toml` still scales to zero, `deploy` warns and `--run` refuses until it is raised.

## Railway

Prereqs: the [Railway CLI](https://docs.railway.com/guides/cli) and `railway login`.

```bash
fastagent deploy railway
```

Generates `railway.json` (with `healthcheckPath=/health`), `Dockerfile`, `.dockerignore`, then prints the runbook. Railway's source of truth is the linked **project's platform state**, not a committed file, so setup is ordered CLI steps:

1. `railway init` — create + link a project (or `railway link` to attach an existing one).
2. `railway add --service <name>` — the volume and variables are service-scoped; the service must exist first.
3. `railway volume add --mount-path /data` — persistent state.
4. `railway variables set FASTAGENT_STATE_DIR=/data <SECRETS>` — **before** the first deploy, or the box boots without them.
5. `railway up` — upload + build the Dockerfile on Railway (no local Docker). **A redeploy is this step alone.**
6. `railway domain` — mint the public URL, then register route-channel webhooks; locally onboarded Slack updates from local state, manual Slack prints its URL, and long-connection channels are skipped.

Or:

```bash
fastagent deploy railway --run   # drives the CLI on an UNLINKED dir; carries your local env secrets
```

`--run` refuses a dir already linked to a project unless you pass `--into-linked`. Scale-to-zero (App Sleeping) is a **dashboard-only** toggle Railway exposes no CLI/API for. Don't enable it with GitHub, time triggers, or a long-connection channel; a sleeping service cannot hold an outbound connection.

## Serving an existing directory (embedded layout)

When the workspace is embedded (the whole workspace lives in `./.fastagent/` and the parent directory is the workbench — see [Configuration](configuration.md)), `deploy` uses the SAME semantic as flat — **bake the workbench as the image, WYSIWYG** (what you see is what ships: git or not, clean or dirty) — with the artifacts namespaced:

- **Artifacts land at the workspace root** — `.fastagent/Dockerfile`, `.fastagent/Dockerfile.dockerignore`, and `.fastagent/fastagent.compose.yml` / `.fastagent/fly.toml` / `.fastagent/railway.json` — so they never collide with the host repo's own Docker/deploy files. **One host-tree write**: a `.dockerignore` at the workbench root (context-packers only read that form; it carries the machinery excludes `**/.secrets`, `**/.state`, `**/.cache`, plus `**/node_modules` and `**/.env*`, and does *not* exclude `.git`). If the host already has one it is **kept — even under `--force`** (it's the host's file), and preflight checks it specifically: missing secret excludes (the packer would bake secrets into the image) or a rule matching `.fastagent` (the context would ship without the agent workspace) **gate `--run`** and warn generate-only; a missing `**/.state`/`**/node_modules` warns, and a `.git` exclude gets a note (kills the agent's pull/push loop). Docker Compose builds from the workbench root through the namespaced file; the Fly runbook passes explicit flags (`fly deploy . --config .fastagent/fly.toml --dockerfile .fastagent/Dockerfile`); on Railway the build entry rides the `RAILWAY_DOCKERFILE_PATH` service variable (set with the machinery variables — fully scriptable), and pointing the service at `.fastagent/railway.json` (Settings → Config-as-code — dashboard-only) is an *optional* enhancement: it adds the `/health` deploy gate, while Railway's default restart policy already matches the file's `ON_FAILURE`.
- **The image bakes the whole directory as the agent's workbench.** Only the **workspace's** dependencies (`.fastagent/package.json`) are installed — the host repo's own deps are the agent's runtime concern (it can install them in its workbench when a task needs them).
- **Freshness and write-back run through git, driven by the agent**: when the workbench is a git repo, `git` is baked in and `.git` ships in the image, so the agent can `git pull` to freshen content and `commit`/`push` its work back; credentials ride `config.deploy.secrets` (e.g. `GH_TOKEN`); the *policy* — push vs PR, identity, which remote — belongs in its `persona.md`. **Caveat:** whether `.git` actually reaches the box is host-CLI-dependent (`railway up` is known to strip it; flyctl packs its own context) — verify `git status` on the box after the first deploy, and fall back to having the agent `git clone` its repo in the workbench (same token).
- **The image is a snapshot.** Un-pushed changes on the box do **not** survive a redeploy — durability lives in git, not on the machine. A non-git workbench deploys the same way; its production edits are ephemeral by nature.
- **Definition updates need a redeploy** (the definition is baked). Markdown definition files are live-read per turn, so an agent that pulls a new `persona.md` on the box picks it up next turn; code (tools/channels/config) needs a restart, deps a rebuild.

## Other Docker hosts

The generated `Dockerfile` runs the directory on any container platform; `fastagent.compose.yml` is the local single-machine topology. Bring your own remote Docker host by supplying a persistent volume, secrets, and—only for route channels—public ingress/webhook registration. A long-connection channel requires an always-on process instead.

`config.deploy.apt` bakes extra apt packages into the image; a package needing a custom apt repo or a different base image means providing your own `Dockerfile` (`deploy` keeps an existing one). See [Configuration](configuration.md#config-file).

`.git` ships in the image by default (the agent's pull/push loop needs it); for a smaller image with no git needs, add a `.git` line to the generated `.dockerignore`. The git **binary** is baked in exactly when the directory ships a `.git` (either layout); a non-git directory that still needs git declares `deploy: { apt: ["git"] }` in `fastagent.config.*`.

## Single-machine tier

All shipped recipes are single-machine: state lives on **one** volume tied to **one** machine/service. Scaling to multiple instances gives each its own volume and splits sessions/turns — that needs a shared/external backend on the `PiSessionStore` / `Lease` seams (see [Embedding](embedding.md)), not this recipe. Don't scale past one instance.

## Where next

- [CLI reference](cli.md) — the full `deploy` flag list.
- [Configuration](configuration.md) — `deploy.secrets`, `deploy.apt`, and state-root knobs.
- [Channels](channels.md) — webhook registration and the fire-and-forget vs replay model.
