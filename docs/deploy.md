---
title: Deploy
description: "Ship the directory: local Docker Compose, Fly.io, Railway, AWS Bedrock AgentCore, portable containers, secrets, persistent state, and scale-to-zero behavior."
status: current
---

# Deploy

FastAgent has **no application build step** — the directory is the deployable unit. Deployment is: copy the agent to a host with Node >= 22.19 (or Bun), install dependencies, and run `fastagent start`. The `deploy` command wraps that for a target: it generates a definition-aware container recipe plus target config and prints an ordered runbook. `--run` drives the target CLI instead of handing you the runbook.

```bash
fastagent deploy docker                 # Dockerfile + local Compose + runbook
fastagent deploy docker --tunnel        # generate Compose with a Quick Tunnel service
fastagent deploy docker --run           # start the app service
fastagent deploy docker --tunnel --run  # start app+tunnel and register webhooks
fastagent deploy fly           # Dockerfile + fly.toml + runbook
fastagent deploy fly --run
fastagent deploy railway
fastagent deploy railway --run
fastagent deploy agentcore       # CloudFormation stack for AWS Bedrock AgentCore + runbook
fastagent deploy agentcore --run
```

FastAgent generates only what it can know from the definition: image shape, state root, exact secret names, channel paths, and target-specific runtime settings. Local Docker can opt into an ephemeral Cloudflare Quick Tunnel; durable ingress, reverse proxies, DNS, and TLS remain operator-owned. Generation and execution stay separate: `--tunnel` shapes Compose, while `--run` is the only flag that starts Docker.

## Before you deploy

Three things must be true, or the deployed box crash-loops on boot:

| Requirement | Why | How |
|---|---|---|
| **A model resolves** | The usual `flag > environment > config` chain, evaluated in **the environment being deployed** rather than this machine's. That environment is declared by `.secrets/.env`, so its `FASTAGENT_MODEL` wins and `deploy` bakes it into the generated Dockerfile as an `ENV`; `config.model` is the fallback and ships in the config file. Your shell is not part of the deployed environment, and `deploy` has no `--model` flag (a generated Dockerfile is rewritten every deploy, so a flag baked into one would vanish on the next). | Either source. `deploy` prints the effective model and its source, and warns (or, under `--run`, gates) when neither resolves one. A hand-written Dockerfile gets neither bake nor `deploy.apt` — `deploy` warns and names what it dropped. |
| **Secrets are declared** | The host needs the model API key and every channel's verification secret. | Env-key model auth + channel secrets are auto-listed; declare anything else in `config.deploy.secrets` (see [Configuration](configuration.md)). |
| **Workspace, state and secrets are durable** | Local directories remain where you created them. | Docker, Fly and Railway keep `base/`, `.state/` and `.secrets/` on a volume at `/data`, and a new release replaces only the nested definition. AgentCore uses managed SessionStorage at `/mnt/data`, which the platform resets on every deploy. |

Model auth: if your local auth is an **env key** (e.g. `OPENAI_API_KEY`), `deploy` lists it as a host secret automatically. In a runbook-only deploy, an OAuth/stored login still needs a provider API key or an `auth.json` placed on the volume. Under `--run`, FastAgent carries the local auth file as an absent-only `FASTAGENT_AUTH_SEED`, so a credential already refreshed on the volume is never overwritten.

## Local Docker

Prerequisite: Docker Engine/Desktop with Docker Compose 2.3.3 or newer (`docker compose version`).

```bash
fastagent deploy docker
```

This generates `fastagent/Dockerfile`, a workspace-root `.dockerignore`, and `fastagent/fastagent.compose.yml`. The Compose file contains one `agent` service:

- the generated or user-owned Dockerfile,
- `127.0.0.1:<port>` for safe host-local access,
- a named volume mounted at `/data`,
- `FASTAGENT_STATE_DIR=/data/.state`, `FASTAGENT_SECRETS_DIR=/data/.secrets`, `PORT`, and the exact model/channel/extra secret names,
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
- `--force` regenerates artifacts fastagent GENERATED (they carry a marker line); a file without that marker is never touched, with or without it. Delete such a file to hand the path back to deploy.
- To regenerate only one artifact while preserving the others, delete that file and rerun (with or without `--force`).
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
3. `fly ips allocate-v4 --shared` + `fly ips allocate-v6` — one-time, free. `[http_service]` declares a service; it does not allocate an address to reach it on. `fly deploy` does that on a *first* deploy only, and just warns when it fails — leaving a machine that serves and a `https://<name>.fly.dev` with no DNS record. Skip if `fly ips list` already shows one.
4. `fly secrets set …` — the model key + each channel's secrets, with `<value>` placeholders to fill.
5. `fly deploy` builds and ships. For a new definition release, run `fastagent deploy fly` first to refresh the release manifest, then build and ship again.
6. Register each route channel's webhook at the live URL. Locally onboarded Slack updates its App Manifest from the builder machine; scaffold-only/manual Slack prints the console URL. WebSocket long-connection channels make no registration call.

Or let the CLI do all of it:

```bash
fastagent deploy fly --run   # idempotent, resumable; carries your local env secrets to Fly
```

Idle behavior defaults to **suspend** (snapshot + fast resume on the next webhook, ~hundreds of ms). Flags: `--stop` (cold-stop instead of suspend), `--no-scale-to-zero` (keep one machine always up), `--force` (overwrite artifacts). A GitHub channel forces one machine to stay up because its fire-and-forget turns have no replay. A long-connection channel also forces one machine up because its outbound connection cannot wake a stopped machine.

**Time triggers and long-connection channels keep one machine running.** Cron/wake has no inbound request at its firing instant; an outbound WebSocket similarly cannot wake from zero. Pre-flight detects long connections structurally, including custom channels, and generated Fly config forces `min_machines_running = 1` (Railway forbids App Sleeping). If a kept `fly.toml` still scales to zero, `deploy` warns and `--run` refuses until it is raised — including under `--force`, which does not rewrite a `fly.toml` you own.

## Railway

Prereqs: the [Railway CLI](https://docs.railway.com/guides/cli) and `railway login`.

```bash
fastagent deploy railway
```

Generates `railway.json` (with `healthcheckPath=/health`), `Dockerfile`, `.dockerignore`, then prints the runbook. Railway's source of truth is the linked **project's platform state**, not a committed file, so setup is ordered CLI steps:

1. `railway init` — create + link a project (or `railway link` to attach an existing one).
2. `railway add --service <name>` — the volume and variables are service-scoped; the service must exist first.
3. `railway volume add --mount-path /data` — persistent state.
4. `railway variables set FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets <SECRETS>` — **before** the first deploy, or the box boots without them.
5. `railway up` uploads and builds the Dockerfile on Railway. For a new definition release, run `fastagent deploy railway` first to refresh the release manifest.
6. `railway domain` — mint the public URL, then register route-channel webhooks; locally onboarded Slack updates from local state, manual Slack prints its URL, and long-connection channels are skipped.

Or:

```bash
fastagent deploy railway --run   # drives the CLI on an UNLINKED dir; carries your local env secrets
```

`--run` refuses a dir already linked to a project unless you pass `--into-linked`. Scale-to-zero (App Sleeping) is a **dashboard-only** toggle Railway exposes no CLI/API for. Don't enable it with GitHub, time triggers, or a long-connection channel; a sleeping service cannot hold an outbound connection.

## AWS Bedrock AgentCore

Prereqs: AWS CLI v2 with credentials in a [region where AgentCore is available](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html), and Docker with buildx — this is the one target whose image builds **on your machine** (the platform requires a linux/arm64 image in your account's ECR and has no remote builder). No VPC, no filesystem and no other AWS resource has to exist first.

```bash
fastagent deploy agentcore
```

Generates `fastagent/agentcore.template.yaml`, `fastagent/lambda/index.js` when needed, container files and a release manifest, then prints the runbook: create the ECR repository, `docker buildx build --platform linux/arm64 … --push` with a **unique tag per deploy**, `aws cloudformation deploy` with the secret parameters, read the stack outputs, register webhooks. `--run` drives all of it (aws + docker CLIs) and carries your local model credential.

After deployment, read the agent process logs without hunting through CloudWatch:

```bash
fastagent logs agentcore --follow
```

The command resolves the same workspace-derived CloudFormation stack, reads its `RuntimeArn`, discovers the actual per-endpoint log group, and tails it — the same FastAgent stdout/stderr messages emitted locally. It does not change logging behavior or `FASTAGENT_LOG_LEVEL` (`start` remains `info`; set the existing environment knob to `debug` when the detailed turn trace is needed). The public ingress is a separate Lambda and therefore a separate source:

```bash
fastagent logs agentcore --source forwarder --follow
```

AWS creates each log group on first use. Before the first Runtime invocation or forwarder event, the command says which trigger is missing instead of sending `aws logs tail` to a nonexistent group. Pass the same `[dir]` used for deploy when running from somewhere else.

AgentCore differs from the resident-box hosts in kind — the platform has **no public URL** (ingress is the SigV4 `InvokeAgentRuntime` API only) and **no resident process** (compute is per-session microVMs, reclaimed after the configured idle timeout — 3 minutes by default). The second half is a hard constraint on the agent, not just on the host: a turn here cannot require the previous turn's process, which is SPEC MUST 6 — see [conformance levels](design/conformance-levels.md). The stack therefore carries:

- the **Runtime** (your container, unchanged — the AgentCore adapter mounts `POST /invocations` + `GET /ping` via `FASTAGENT_AGENTCORE=1`);
- a **forwarder Lambda** with a public Function URL fronting the webhooks (channels verify signatures exactly as on every host);
- **EventBridge Scheduler rules** delivering each `schedules/*.ts` cron slot (the container arms no resident timers; delivery is slot-idempotent). A cron EventBridge cannot express is refused at deploy time, never silently dropped;
- with `selfSchedule: true`, the **wake-alarm wiring**: pending wake-ups are mirrored (via the forwarder, authenticated by a minted shared secret) into self-deleting one-shot EventBridge schedules that wake the container at the right instant.

What to know before choosing it:

- **The idle tail is the standing cost, and you set it.** Compute is reclaimed after `deploy.agentcore.idleTimeoutSeconds` (default 180 s, AWS bounds 60–1209600) of idle, and memory bills for that whole tail; a session past it cold-starts on the next message. A chat agent talked to in bursts is cheaper to keep warm than to restart, a schedule-only agent is not — raise or lower it in `fastagent.config.*`. A turn in flight is never cut short: `/ping` reports `HealthyBusy` while work is running.
- **A deploy resets the state.** Storage is the platform's managed SessionStorage at `/mnt/data`. It keeps the workspace, `.state` and `.secrets` across compute stop/resume — an idle-reclaimed agent resumes with its memory — and AWS **wipes it on every runtime version update, i.e. on every deploy**, and after 14 idle days. So sessions, channel state and pending wake-ups start blank after each deploy. Cross-deploy memory would need EFS or S3 Files, both VPC-only and therefore a NAT gateway for model/channel egress (~$33/mo standing); if you need it, use `deploy fly` or `deploy railway` and their real volumes. The S3 bucket here holds only the forwarder deployment package.
- **Deploying is re-authenticating.** The credential seed is absent-only, so a restart keeps an `auth.json` the box rotated and a deploy re-seeds from `FASTAGENT_AUTH_SEED`. Caveat for OAuth: a refresh token is single-use and shared with your machine, so the box can lose model access between deploys — deploy again, or use a provider API key.
- **Nothing opens before the first invocation.** Runtime filesystems appear on invoke, so `/ping` answers immediately while the definition, credentials and channels wait for the first envelope. `deploy --run` probes exactly that path, so a bad credential or a broken `channels/` module fails at deploy time with the runtime's own error text.
- **Redeploys stop the fixed runtime session** so the next call uses the new image. In-flight work is interrupted, and its state is wiped with the mount — replay does not survive a deploy here.
- **Long-connection channels cannot run here** — the connection is the ingress and nothing wakes a reclaimed session; switch the channel to webhook mode (`--run` gates on this).
- **Programmatic invokes reuse the deployment's fixed `runtimeSessionId`**, printed in the runbook. The envelope's `session` still selects an independent conversation. The workspace lease rejects competing writers.
- **The webhook body limit is the host's, not the channel's.** A Lambda Function URL request caps at 6 MB, so a webhook body over roughly 4 MiB cannot reach the container at all — the GitHub channel's own 25 MiB contract is not achievable here, and `deploy agentcore` says so when that channel is present.
- **The template is the topology.** If a kept `agentcore.template.yaml` no longer matches the definition (you added a schedule, a channel, or `selfSchedule`), `--run` stops until you regenerate with `--force` (hand-written templates — marker removed — are always kept and never gated).

## Serving an existing repo (agentDir layout)

## What deploy bakes

Deploy requires a nested definition. Point it at the workspace containing `fastagent/` (or another selected agent directory). The image initializes persistent storage once:

```text
<persistent-root>/
├── base/                 # Working directory, project files and optional .git
│   └── fastagent/        # Deployment-managed definition
├── .state/               # Sessions, channels and scheduled work
├── .secrets/             # Credentials, including refreshed auth.json
└── .deployment/          # Release and recovery metadata
```

Every `fastagent deploy <host>` invocation, including generation without `--run`, writes a new release ID to `fastagent/fastagent.release.json`. Building and deploying that manifest publishes a new definition release even when the author's files are unchanged. Regenerate it before manually building a new release. Restarting the same release preserves definition edits. A different release replaces only `base/fastagent/`, including deleting obsolete definition files. Other workspace files, uncommitted/untracked work, Git history and refreshed credentials remain. Author-side project-code updates outside the definition require explicit synchronization. Definition replacement may leave a dirty Git tree.

Startup stages updates before publishing them and completes an interrupted update before opening the agent. A kernel file lock excludes competing starters until the owner exits. Keep `.deployment/lock` in place even when the service is stopped; removing the inode would bypass another starter's lock. Custom images need `flock`. Credentials seed only when absent. Download caches live under `/tmp/fastagent/`, off the volume.

On AgentCore the same layout sits on managed SessionStorage, which the platform wipes on every deploy — see [above](#aws-bedrock-agentcore).

- **Artifacts land in the agent dir** — `fastagent/Dockerfile`, `fastagent/Dockerfile.dockerignore`, and `fastagent/fastagent.compose.yml` / `fastagent/fly.toml` / `fastagent/railway.json` — so they never collide with Docker/deploy files the workspace already owns. **One write outside the agent dir**: a `.dockerignore` at the workspace root (context-packers only read that form; it excludes `.secrets` contents (except tracked `.env.example` + `.gitignore`) and `**/.state`, plus `**/node_modules`, `**/.cache` and `**/.env*`, and does *not* exclude `.git`). **Ownership decides what deploy may overwrite, not `--force` and not the path.** Every generated artifact opens with a marker line: `--force` regenerates ONES WE WROTE, and a file without the marker is never touched (delete it to hand the path back). So a hand-written `Dockerfile`, a `.dockerignore` the repo already had, or a `fly.toml` you tuned all survive `--force`. **The `Dockerfile` is the one exception in the other direction**: a *generated* one is build output and is refreshed on every deploy, with or without `--force`, because what lives only there (`deploy.apt`, and the `ENV FASTAGENT_MODEL` baked from `.secrets/.env`) would otherwise ship an image that contradicts the definition. To keep edits to it, delete the marker line — deploy then treats the file as yours and warns about what it could not apply. For a kept `.dockerignore`, preflight then asks it about the paths that matter: if it would drop the agent dir (the context ships without the agent) or would NOT exclude `fastagent/.secrets/auth.json` (the packer bakes credentials into the image), that **gates `--run`** and warns generate-only; an unexcluded `.state`/`node_modules` warns, and a `.git` exclude gets a note (kills the agent's pull/push loop). Note that dockerignore patterns are root-anchored: a bare `.secrets` line covers only the workspace root, not the agent's own `fastagent/.secrets` — use `**/.secrets/**`, then re-include the two tracked scaffolds when `.git` ships. Docker Compose builds from the workspace root through the namespaced file; the Fly runbook passes explicit flags (`fly deploy . --config fastagent/fly.toml --dockerfile fastagent/Dockerfile`); on Railway the build entry rides the `RAILWAY_DOCKERFILE_PATH` service variable (set with the machinery variables — fully scriptable), and pointing the service at `fastagent/railway.json` (Settings → Config-as-code — dashboard-only) is an *optional* enhancement: it adds the `/health` deploy gate, while Railway's default restart policy already matches the file's `ON_FAILURE`.
- **The image initializes the whole workspace.** Only the agent's dependencies (`fastagent/package.json`) are installed at build time. Keep the deploy CLI and the agent's FastAgent dependency on the same version. Other project dependencies are installed when needed.
- **Git collaboration follows the agent's policy**: when the workspace is a git repo, `git` is baked in and `.git` ships in the image, so the agent can `git pull` to freshen content and `commit`/`push` its work back; credentials ride `config.deploy.secrets` (e.g. `GH_TOKEN`); the *policy* — push vs PR, identity, which remote — belongs in its `persona.md`. **Caveat:** whether `.git` actually reaches the box is host-CLI-dependent (`railway up` is known to strip it; flyctl packs its own context) — verify `git status` on the box after the first deploy, and fall back to having the agent `git clone` its repo in the workspace (same token).
- **Git is optional collaboration, not a persistence requirement.** Non-Git workspaces retain ongoing work too.
- **Definition edits survive restarts.** Markdown is live-read each turn; tools, channels and configuration need a service restart. A new release can replace those edits. The deployed system prompt explains this boundary.

## Other Docker hosts

The generated `Dockerfile` runs the directory on any container platform; `fastagent.compose.yml` is the local single-machine topology. Bring your own remote Docker host by supplying a persistent volume, secrets, and—only for route channels—public ingress/webhook registration. A long-connection channel requires an always-on process instead.

`config.deploy.apt` bakes extra apt packages into the image; a package needing a custom apt repo or a different base image means providing your own `Dockerfile` (`deploy` keeps an existing one). See [Configuration](configuration.md#config-file).

`.git` ships in the image by default (the agent's pull/push loop needs it); for a smaller image with no git needs, add a `.git` line to the generated `.dockerignore`. The git **binary** is baked in exactly when the workspace ships a `.git`; a non-git workspace that still needs git declares `deploy: { apt: ["git"] }` in `fastagent.config.*`.

## Single-machine tier

Resident recipes require **one active replica** with durable storage. Multiple replicas need shared storage and coordination for sessions, channel state, and scheduled work; separate volumes split those records. The `PiSessionRecordStore` / `Lease` seams cover engine sessions (see [Embedding](embedding.md)), not every channel's state.

AgentCore uses one SessionStorage workspace and one fixed runtime session for every entry point; separate conversations still use separate envelope session ids. That storage does not survive a deploy.

## Where next

- [CLI reference](cli.md) — the full `deploy` flag list.
- [Configuration](configuration.md) — `deploy.secrets`, `deploy.apt`, and state-root knobs.
- [Channels](channels.md) — webhook registration and the fire-and-forget vs replay model.
