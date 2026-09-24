---
title: Deploy
description: "Ship the directory: local Docker Compose, Fly.io, Railway, AWS Bedrock AgentCore, portable containers, secrets, persistent state, and scale-to-zero behavior."
status: current
---

# Deploy

FastAgent has no application build step: the directory is the deployable unit. Deploying means copying the agent to
a host with Node >= 22.19 (or Bun), installing dependencies, and running `fastagent start`. `fastagent deploy`
generates a container recipe and target config and prints an ordered runbook; `--run` executes it with the host's
CLI.

```bash
fastagent deploy docker                 # Dockerfile + local Compose + runbook
fastagent deploy docker --tunnel        # Compose with a Quick Tunnel service
fastagent deploy docker --run           # start the app service
fastagent deploy docker --tunnel --run  # start app + tunnel and register webhooks
fastagent deploy fly                    # Dockerfile + fly.toml + runbook
fastagent deploy fly --run
fastagent deploy railway
fastagent deploy railway --run
fastagent deploy agentcore              # CloudFormation stack for AWS Bedrock AgentCore + runbook
fastagent deploy agentcore --run
```

Only `--run` touches a host. Durable ingress, reverse proxies, DNS and TLS are yours.

## Before you deploy

| Requirement | How |
|---|---|
| **A model resolves** | `FASTAGENT_MODEL` in `.secrets/.env`, else `config.model`. Your shell is not read and `deploy` has no `--model` flag. The value from `.secrets/.env` is recorded in `fastagent.release.json`. `deploy` prints the effective model and gates `--run` when none resolves. A hand-written Dockerfile must set `ENV FASTAGENT_RELEASE_FILE` for that manifest to be read; `deploy` gates the combination otherwise. |
| **`.secrets/.env` holds the deployed environment** | `--run` carries every variable in it, except `PORT` and the `FASTAGENT_*` names the deployment sets itself. A variable exported in your shell does not travel. Names declared by code (`defineTool`/`defineChannel`/`defineRoutine({ secrets })`) and the model's env key must have a value there, or `--run` stops before its first side effect. In CI, write the file before running the command. |
| **A model credential** | An env-key credential travels as a variable. An OAuth/stored login travels, under `--run`, as `FASTAGENT_AUTH_SEED` and is written to the volume only when no `auth.json` is there, so a refreshed one is never overwritten. In a manual deploy, set a provider API key or place `auth.json` on the volume. |
| **Durable storage** | Docker, Fly and Railway keep `base/`, `.state/` and `.secrets/` on a volume at `/data`. AgentCore uses managed SessionStorage at `/mnt/data`, reset on every deploy. |

## Local Docker

Requires Docker Compose 2.3.3 or newer.

```bash
fastagent deploy docker
```

Generates `fastagent/Dockerfile`, a workspace-root `.dockerignore`, and `fastagent/fastagent.compose.yml` with one
`agent` service:

- the generated or your own Dockerfile,
- `127.0.0.1:<port>` published on the host,
- a named volume at `/data`,
- `env_file: .secrets/.env` (a fixed path, created empty when missing), with `FASTAGENT_STATE_DIR`,
  `FASTAGENT_SECRETS_DIR`, `FASTAGENT_AUTH_PATH` and `PORT` pinned after it,
- `restart: unless-stopped`.

```bash
docker compose -f fastagent/fastagent.compose.yml up -d --build
docker compose -f fastagent/fastagent.compose.yml logs -f agent
docker compose -f fastagent/fastagent.compose.yml ps
docker compose -f fastagent/fastagent.compose.yml down     # keeps the state volume
docker compose -f fastagent/fastagent.compose.yml down -v  # destructive: deletes all state
```

`--run` checks Docker and the daemon, gates missing values before building, runs `up -d --build`, checks the
services, and waits for `/health`. It passes the one value not in `.secrets/.env`, `FASTAGENT_AUTH_SEED`, through
Compose's environment; a hand-run `up` can set it the same way.

Notes:

- Compose expands `$VAR` inside `env_file` values, so a value containing `$` reaches the container changed.
  `deploy` warns. `$$` fixes Compose but breaks every other reader of the file; prefer a value without `$`.
- If `FASTAGENT_SECRETS_DIR` points this machine at a different value file than the committed Compose reads,
  generating warns and `--run` gates.

### Quick Tunnel

```bash
fastagent deploy docker --tunnel        # add a cloudflared service to the Compose file
fastagent deploy docker --tunnel --run  # start both, read the URL, register webhooks
```

The `tunnel` service points at `http://agent:<port>`. `--run` reads the `*.trycloudflare.com` URL from its logs and
registers webhooks as `dev --tunnel` does: Telegram, locally onboarded Slack and Feishu/Lark automatically,
manual Slack prints its URL, long-connection channels are skipped.

The URL changes whenever the tunnel container or Docker restarts, so the service has no restart policy: re-run
`fastagent deploy docker --tunnel --run` to register the new URL. For a stable endpoint, use your own named tunnel
or reverse proxy.

### Owning the Docker files

- An existing `Dockerfile`, `.dockerignore` or `fastagent.compose.yml` is kept byte for byte and used by `--run`.
- `--force` regenerates only files fastagent generated (they start with a marker line). Remove the marker to own a
  file; delete a file to hand it back.
- `--tunnel` shapes only a newly generated Compose file. `--tunnel --run` against a kept file without a `tunnel`
  service stops before touching Docker.
- `config.deploy.apt` applies only to the generated Dockerfile.
- `--run` relies on the service named `agent` (and `tunnel`). Add other services, networks, volumes or ports freely.

## Fly.io

Requires [flyctl](https://fly.io/docs/flyctl/install) and `fly auth login`.

```bash
fastagent deploy fly
```

Generates `fly.toml`, `Dockerfile` and `.dockerignore`, and prints the runbook:

1. `fly apps create <name>` (names are global; if taken, edit `app` in `fly.toml` and re-run `deploy`).
2. `fly ips allocate-v4 --shared` and `fly ips allocate-v6`. A first `fly deploy` allocates them but only warns if
   that fails, leaving `https://<name>.fly.dev` without DNS. Skip if `fly ips list` shows one.
3. `fly secrets set …` for the listed variables.
4. `fly deploy`, which creates the `data` volume on the first deploy. For a new release, run
   `fastagent deploy fly` first to refresh the release manifest.
5. Register each route channel's webhook at the live URL.

```bash
fastagent deploy fly --run   # idempotent and resumable
```

Idle behavior is **suspend** with `min_machines_running = 0`. Both lines are in `fly.toml` and are yours to edit.

## Railway

Requires the [Railway CLI](https://docs.railway.com/guides/cli) and `railway login`.

```bash
fastagent deploy railway
```

Generates `railway.json` (with `healthcheckPath=/health`), `Dockerfile` and `.dockerignore`, and prints the runbook:

1. `railway init` (or `railway link`).
2. `railway add --service <name>`.
3. `railway volume add --mount-path /data`.
4. `railway variables set FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets …` before the
   first deploy.
5. `railway up`. For a new release, run `fastagent deploy railway` first.
6. `railway domain`, then register webhooks.

```bash
fastagent deploy railway --run   # provisions an unlinked dir end to end
```

`--run` refuses a dir already linked to a project unless `--into-linked`. The build uses the
`RAILWAY_DOCKERFILE_PATH` variable; pointing the service at `fastagent/railway.json` (Settings → Config-as-code,
dashboard only) adds the `/health` deploy gate.

## Scale to zero

| Definition has | Fly (`min_machines_running`) / Railway (App Sleeping) |
|---|---|
| a routine with a `cron` | kept up — unless an external clock calls [`POST /run`](api-reference.md#post-run) instead (Fly Cron Manager or supercronic, a Railway cron service over the private network, a CI job) |
| a long-connection channel | kept up; an outbound connection cannot wake a stopped machine |
| neither | may scale to zero |

The generated `fly.toml` and the Railway runbook follow this table. If a kept `fly.toml` scales to zero where it
should not, `deploy` warns and `--run` refuses until you raise it.

Wake-ups do not keep a machine up: they are stored on the volume, and a machine that scaled to zero fires what is
due when a request next wakes it, late but not lost.

## AWS Bedrock AgentCore

Requires AWS CLI v2 with credentials in a
[region where AgentCore is available](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html),
and Docker with buildx: the linux/arm64 image builds on your machine.

```bash
fastagent deploy agentcore
fastagent deploy agentcore --run
```

Generates `fastagent/agentcore.template.yaml`, `fastagent/lambda/index.js`, container files and a release manifest.
The runbook: create the ECR repository, `docker buildx build --platform linux/arm64 … --push` with a unique tag
per deploy, `aws cloudformation deploy`, read the outputs, register webhooks. `--run` does all of it.

The stack carries:

- the **Runtime** (your container; `FASTAGENT_AGENTCORE=1` serves `POST /invocations` and `GET /ping`);
- a **forwarder Lambda** with a public Function URL: it relays webhooks when a webhook channel exists (channels
  verify signatures as on every host) and manages wake alarms;
- **EventBridge Scheduler rules** for each routine's `cron`. A cron EventBridge cannot express stops the deploy;
- **wake alarms**: pending wake-ups become one-shot EventBridge schedules that wake the container on time.

Variables from `.secrets/.env` ride one NoEcho parameter, `FastagentEnv` (chunked), so adding a name does not
change the template.

What to know:

- **Idle cost.** A session keeps its microVM for `deploy.agentcore.idleTimeoutSeconds` (default 180) after it goes
  idle, and memory bills for that time; after it, the next message cold-starts. `/ping` reports `HealthyBusy`
  while work runs, so a turn is not cut short.
- **Every deploy resets the state.** Managed SessionStorage survives compute stop/resume but is wiped on every
  runtime update (every deploy) and after 14 idle days: sessions, channel state and pending wake-ups start blank.
  For state that survives deploys, use Fly or Railway.
- **Every deploy re-seeds the credential.** With OAuth, the refresh token is shared with your machine and
  single-use, so the box can lose model access between deploys; use a provider API key here.
- **Nothing opens before the first invocation.** `--run` probes that path, so a bad credential or a broken channel
  fails the deploy with the runtime's error.
- **Redeploys stop the runtime session** so the next call uses the new image; in-flight work is lost.
- **No long-connection channels.** Use webhook mode; `--run` refuses otherwise.
- **Programmatic invokes** use the deployment's fixed `runtimeSessionId` (printed in the runbook); the envelope's
  `session` selects the conversation.
- **Webhook bodies over about 4 MiB** cannot pass the Lambda Function URL (6 MB request cap).
- **A kept template that no longer matches the definition** (a new routine or channel) stops `--run` until
  `--force`. A template without the marker line is never regenerated.

### Logs

```bash
fastagent logs agentcore --follow                    # the Runtime's stdout/stderr
fastagent logs agentcore --source forwarder --follow  # the forwarder Lambda
```

Log groups appear on first use; before that, the command says what has not happened yet. CloudWatch keeps logs
forever by default, and they are where a failed scheduled turn's reason is. Set a retention (the runbook and
`--run` print this):

```bash
aws logs put-retention-policy --log-group-name <group> --retention-in-days 14
```

### Tearing it down

```bash
fastagent destroy agentcore        # list what exists; delete nothing
fastagent destroy agentcore --run  # delete it
```

Deletes the stack, the artifact bucket, the ECR repository, both log groups and pending wake alarms, which
`aws cloudformation delete-stack` alone leaves behind. It prints the account and region first. A read it cannot
complete stops the command. A stack that does not reach `DELETE_COMPLETE` stops the rest.

- Conversations are deleted with the stack. A bucket holding anything besides forwarder packages is kept and
  reported.
- Webhook registrations on Telegram, Slack or Feishu are not removed. Clear them yourself (Telegram:
  `curl "https://api.telegram.org/bot<token>/deleteWebhook"`).

## What deploy bakes

Deploy needs a nested definition: point it at the workspace containing `fastagent/`. The image initializes
persistent storage once:

```text
<persistent-root>/
├── base/                 # working directory, project files, optional .git
│   └── fastagent/        # deployment-managed definition
├── .state/               # sessions, channels, scheduled work
├── .secrets/             # credentials, including refreshed auth.json
└── .deployment/          # release and recovery metadata
```

- Every `fastagent deploy <host>` writes a new release id to `fastagent/fastagent.release.json` (rewritten every
  time; do not edit it). Restarting the same release keeps definition edits; a new release replaces only
  `base/fastagent/`, deleting obsolete definition files. Other workspace files, uncommitted work, Git history and
  credentials stay.
- Updates are staged and an interrupted one completes before the agent opens. A file lock at
  `.deployment/lock` excludes competing starters; do not delete it. Custom images need `flock`.
- Only `fastagent/package.json` dependencies install at build time; keep the deploy CLI and the agent's FastAgent
  dependency on the same version.
- Markdown in the definition is read every turn; tools, channels and config need a restart; a new release replaces
  edits made on the box.

**Artifacts** land in the agent dir (`Dockerfile`, `Dockerfile.dockerignore`, `fastagent.compose.yml` /
`fly.toml` / `railway.json`). The one file outside it is the workspace-root `.dockerignore`, which excludes
`.secrets` contents (except `.env.example` and `.gitignore`), `**/.state`, `**/node_modules`, `**/.cache` and
`**/.env*`, and keeps `.git`.

- Generated artifacts start with a marker line. `--force` regenerates only those; a file without the marker is
  never touched.
- A generated artifact that no longer matches the definition is kept and reported, and gates `--run`.
- A kept `.dockerignore` that drops the agent dir or does not exclude `fastagent/.secrets/auth.json` gates `--run`;
  an unexcluded `.state` or `node_modules` warns. Patterns are root-anchored: use `**/.secrets/**`.

**Git**: when the workspace is a repo, `git` is installed and `.git` ships, so the agent can pull and push;
credentials go in `.secrets/.env` (e.g. `GH_TOKEN`) and the push policy in `persona.md`. Some host CLIs strip
`.git` (`railway up` does), so check `git status` on the box after the first deploy. A non-git workspace that needs
git sets `deploy: { apt: ["git"] }`. Add `.git` to `.dockerignore` for a smaller image.

## Other Docker hosts

The generated `Dockerfile` runs on any container platform. Supply a persistent volume, the variables, and, for
route channels, public ingress and webhook registration. A long-connection channel needs an always-on process.

## Single-machine tier

Resident deployments need **one active replica** with durable storage. More replicas need shared storage and
coordination for sessions, channel state and scheduled work. The `PiSessionRecordStore` / `Lease` seams cover
engine sessions (see [Embedding](embedding.md)), not channel state.

## Where next

- [CLI reference](cli.md)
- [Configuration](configuration.md)
- [Channels](channels.md)
