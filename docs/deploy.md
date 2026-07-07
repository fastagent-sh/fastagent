---
title: Deploy
status: current
---

# Deploy

FastAgent has **no build step** — the directory is the deployable unit. Deployment is: copy the workspace to a host with Node >= 22.19 (or Bun), install dependencies, and run `fastagent start`. The `deploy` command wraps that for a specific host: it generates the host config + container recipe from your resolved definition and prints an ordered, values-filled runbook. `--run` drives the host CLI to completion instead of handing you the runbook.

```bash
fastagent deploy fly       # generate artifacts + print a flyctl runbook
fastagent deploy fly --run # drive flyctl to completion
fastagent deploy railway
fastagent deploy railway --run
```

Two ends only FastAgent can compute are generated for you — the definition-aware artifacts (state root → volume, the exact secret list, autostop tuned to the turn model) and the post-deploy webhook step. The middle (the host CLI) is either a runbook you (or a coding agent) run, or `--run`.

## Before you deploy

Three things must be true, or the deployed box crash-loops on boot:

| Requirement | Why | How |
|---|---|---|
| **Model is in `fastagent.config.*`** | A `--model` flag, `FASTAGENT_MODEL`, or `.env` value is builder-local and does **not** travel (`.env` is dockerignored). Only the config file ships. | `model: "provider/id"` in `fastagent.config.mjs`. `deploy` warns (or, under `--run`, gates) if it's missing. |
| **Secrets are declared** | The host needs the model API key and every channel's verification secret. | Env-key model auth + channel secrets are auto-listed; declare anything else in `config.deploy.secrets` (see [Configuration](configuration.md)). |
| **State goes on a volume** | Sessions, `auth.json`, and channel state live under one root; a redeploy that replaces the directory wipes them otherwise. | Both recipes mount a volume at `/data` and set `FASTAGENT_STATE_DIR=/data`. |

Model auth: if your local auth is an **env key** (e.g. `OPENAI_API_KEY`), `deploy` lists it as a host secret automatically. If it's an OAuth/stored login, the plan can't read its value — set a provider API key as a host secret, or place `auth.json` on the volume yourself.

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
5. Register each channel's webhook at the live URL (`https://<name>.fly.dev/telegram`, `/webhook`).

Or let the CLI do all of it:

```bash
fastagent deploy fly --run   # idempotent, resumable; carries your local env secrets to Fly
```

Idle behavior defaults to **suspend** (snapshot + fast resume on the next webhook, ~hundreds of ms). Flags: `--stop` (cold-stop instead of suspend), `--no-scale-to-zero` (keep one machine always up), `--force` (overwrite artifacts). A GitHub channel forces one machine to stay up — its fire-and-forget turns have no replay, so scaling the last machine to zero could drop an in-flight review.

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
6. `railway domain` — mint the public URL (Railway's `*.up.railway.app` is not deterministic; read it back), then register each channel's webhook against it.

Or:

```bash
fastagent deploy railway --run   # drives the CLI on an UNLINKED dir; carries your local env secrets
```

`--run` refuses a dir already linked to a project unless you pass `--into-linked`. Scale-to-zero (App Sleeping) is a **dashboard-only** toggle Railway exposes no CLI/API for — the runbook states it as a manual step (Settings → Deploy → Serverless → App Sleeping). Don't enable it with a GitHub channel, for the same no-replay reason as Fly.

## Serving an existing repo (agentDir layout)

When the workspace uses `config.agentDir` (a coding agent living in `./agent` whose cwd is the host repo — see [Configuration](configuration.md)), `deploy` generates a **repo-as-workspace** recipe instead:

- **Artifacts are namespaced under the kit** — `agent/Dockerfile`, `agent/Dockerfile.dockerignore`, and `agent/fly.toml` / `agent/railway.json` — so they never collide with the host repo's own `Dockerfile`/deploy files. **One root-level exception**: a `.dockerignore` is written at the repo root (host context-packers read only that form; it carries recursive `**/node_modules`, `**/.env`… excludes and does *not* exclude `.git`). If the host already has one it is **kept — even under `--force`** (it's the host's file), and the preflight warns specifically when it excludes `.git` (kills baked write-back) or lacks `**/node_modules` (native-binary clobber). The runbook passes explicit flags (`fly deploy . --config agent/fly.toml --dockerfile agent/Dockerfile`); on Railway, point the service at `agent/railway.json` (Settings → Config-as-code — dashboard-only).
- **The image bakes the whole repo as the agent's cwd.** Only the **kit's** dependencies (`agent/package.json`) are installed — the host repo's own deps are the agent's runtime concern (it can install them in its workspace when a task needs them).
- **Write-back mechanics ship in the image**: `git` is baked in and the generated ignore files do **not** exclude `.git`; credentials ride `config.deploy.secrets` (e.g. `GH_TOKEN`); the *policy* — push vs PR, identity, which remote — belongs in its `persona.md`. **Caveat:** whether `.git` actually reaches the box is host-CLI-dependent (`railway up` is known to strip it; flyctl packs its own context) — verify `git status` on the box after the first deploy, and fall back to having the agent `git clone` its repo in the workspace (same token).
- **The workspace is a snapshot.** The image is the repo at deploy time; un-pushed changes on the box do **not** survive a redeploy — durability lives in git, not on the machine.
- **Status: experimental** — this layout has not been verified end-to-end on a real host yet (the preflight note says so). `--run` is not supported for it (gated); follow the printed runbook.

## Any Docker host

The generated `Dockerfile` runs the directory on any container platform — the `deploy` targets above just wire the platform specifics around it. Bring your own host by using the `Dockerfile` directly and providing, yourself, what the recipes automate: a persistent volume mounted where `FASTAGENT_STATE_DIR` points, the secrets as env vars, and the channel webhooks.

`config.deploy.apt` bakes extra apt packages into the image; a package needing a custom apt repo or a different base image means providing your own `Dockerfile` (`deploy` keeps an existing one). See [Configuration](configuration.md#config-file).

If your agent runs git over its **own** history (`git log`/`git blame` on the repo it ships in), delete the `.git` line from the generated `.dockerignore` so history is included.

## Single-machine tier

All shipped recipes are single-machine: state lives on **one** volume tied to **one** machine/service. Scaling to multiple instances gives each its own volume and splits sessions/turns — that needs a shared/external backend on the `PiSessionStore` / `Lease` seams (see [Embedding](embedding.md)), not this recipe. Don't scale past one instance.

## Where next

- [CLI reference](cli.md) — the full `deploy` flag list.
- [Configuration](configuration.md) — `deploy.secrets`, `deploy.apt`, and state-root knobs.
- [Channels](channels.md) — webhook registration and the fire-and-forget vs replay model.
