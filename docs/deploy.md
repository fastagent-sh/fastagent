---
title: Deploy
description: "Ship the directory: local Docker Compose, Fly.io, Railway, AWS Bedrock AgentCore, portable containers, secrets, persistent state, and scale-to-zero behavior."
status: current
---

# Deploy

The deployable unit is the agent directory with its built `dist/`. Deploying means copying the agent to a host with
Node >= 24.15 (or Bun >= 1.4), installing dependencies, and running `fastagent build && fastagent start`. `deploy`
runs `fastagent build` first, with or without `--run`, so a type error stops it before anything ships, and the generated
Dockerfile builds `dist/` again after copying the directory, since an upload that follows `.gitignore` (`railway up`)
leaves the git-ignored `dist/` out. A hand-written Dockerfile does the same, or its image has no build for `start` to
open. `fastagent deploy`
generates a container recipe and target config and prints an ordered runbook; `--run` executes it with the host's
CLI.

```bash
fastagent deploy docker                 # Dockerfile + local Compose + runbook
fastagent deploy docker --run           # start the app service
fastagent deploy fly                    # Dockerfile + fly.toml + runbook
fastagent deploy fly --run
fastagent deploy railway
fastagent deploy railway --run
fastagent deploy agentcore              # CloudFormation stack for AWS Bedrock AgentCore + runbook
fastagent deploy agentcore --run
fastagent deploy fly --run --json       # a coding agent's deploy: a ticket, its person's steps handed back
fastagent deploy fly --run --config production.json   # with the instance configuration it runs on
```

Only `--run` touches a host. Durable ingress, reverse proxies, DNS and TLS are yours.

A deployment runs on the program's defaults, and `--config <file>` gives it an instance configuration of its own (a
`fastagent.json`: model, settings, `http`, `deploy`, repositories it works on). The deploy decides with it (its model,
whether it serves the Agent API, AgentCore's idle timeout), and carries it in the image: it writes it into `fastagent.deploy/` (a build output, like
`fastagent.release.json`; `{}` without `--config`), and the generated Dockerfile copies that directory to
`/etc/fastagent/` and names it with `FASTAGENT_CONFIG`, which the box reads at every start. A hand-written Dockerfile does
the same, or a delivered configuration stops `--run`. The project's own `fastagent.json`
is the development instance's: a deploy never carries it, and the generated `.dockerignore` keeps it out of the image.
A configuration holds no secret value.

A coding agent deploys with `--run --json`. The deploy runs in a process of its own and the command returns its
ticket; the agent checks it with `fastagent deploy <host> --check <ticket>` and relays each `need_user_action`: the
host's CLI sign-in (`fly auth login`, `railway login`, run for the person, who approves in the browser), a production
Feishu app to confirm, the box's model login. It ends `done` with the deployment's URL. AWS credentials for
AgentCore are typed by the person: a ticket without them fails saying to run `aws configure` in a terminal of their
own. See [`fastagent deploy`](cli.md#commands).

## Before you deploy

| Requirement | How |
|---|---|
| **A model resolves** | `FASTAGENT_MODEL` in `.secrets/production/.env`, else `config.model`. Your shell is not read and `deploy` has no `--model` flag. The value from `.secrets/production/.env` is recorded in `fastagent.release.json`. `deploy` prints the effective model and gates `--run` when none resolves. A hand-written Dockerfile must set `ENV FASTAGENT_RELEASE_FILE` for that manifest to be read; `deploy` gates the combination otherwise. |
| **The target holds the values** | On Fly and Railway the values live in the target's own store (Fly secrets, the service's variables), on Docker in `.secrets/production/.env`, which Compose reads. `--run` checks names, never carries a file: the names declared by code (`needs([...])`), the variables `context.json` declares and a model key with no login to fall back on must have a value on the target, or `--run` stops before building. At a terminal it asks: the names `.secrets/production/.env` holds are set there from it after one question, the rest are typed without echo. In a coding agent's deploy, or in CI, it stops naming `fastagent secrets push <host>` and `fastagent secrets set <host> <NAME>`; run them, then re-run. A variable the definition does not declare is not pushed. On AgentCore the values are one Secrets Manager secret, `fastagent/<name>`. See [Secrets](cli.md#fastagent-secrets). |
| **A model credential** | What `deploy` ships decides how it gets there, never what authenticates the model on this machine (your logins and your shell's variables stay here). The provider's key variable is a name the target may hold (set it with `fastagent secrets`), and so is a key a provider in `fastagent.config.ts` reads through `needs`; a provider in code that resolves its own key needs nothing more. Otherwise the box answers: it keeps what it already authenticates with, and logs in if it has nothing, see [Logging a deployment in](#logging-a-deployment-in). |
| **Something reaches it** | A channel, a schedule, or the [Agent API](#the-agent-api). A deployment with none of them is reached by nothing but its health check, and `deploy` warns: an agent used only from an app is embedded in it, not deployed. |
| **Durable storage** | Docker, Fly and Railway make a volume at `/data` the agent's working directory, holding `.state/`, `.secrets/`, `content/` and what the agent writes. AgentCore uses managed SessionStorage at `/mnt/data`, reset on every deploy. |
| **Content that reaches a host** | A `github` [content entry](configuration.md#content) is cloned on the host, at its `ref`, and brought up to date in place at each start, as on your machine without a checkout. Preflight says so for each one; on AgentCore, whose storage every deploy starts over, it says what the agent did not push is lost. The host clones with `GITHUB_TOKEN` (set it like any other value, with `fastagent secrets`), needed for a private repository and for the agent to push; without it preflight notes that only public repositories are reachable. The image installs `git`. A directory in the configuration `--config` delivers is refused: the host has no such path. Copy what the agent only reads into the agent directory, outside `content/`, which every release ships; move what it works on and must keep to a repository. |

### Reproduce it here first

A deployment differs from your `dev` in three ways, and each has its own local check:

| What differs | Check it with |
|---|---|
| The artifact: the built `dist/`, not the source | `fastagent build && fastagent start` |
| The inputs: the production values and configuration, and no state | `fastagent start --root $(mktemp -d)`: `start` reads `.secrets/production/.env`, and `--config <file>` gives it the deployment's configuration when there is one |
| The machine: the image's operating system, commands and packages | `fastagent deploy docker --run`, which runs the deployment's image on this machine |

The image is built for this machine's architecture, so a native dependency that fails only on another (an arm64 laptop,
an amd64 host) is not caught here.

## The Agent API

Docker, Fly and Railway deployments serve the [Agent API](SPEC.md#9-http) under `/v1`, behind
`FASTAGENT_API_KEY`. When neither the target nor `.secrets/production/.env` has one, `--run` makes one, sets it on the
target and keeps it in that file, where `invoke --url` reads it; `fastagent secrets set <host> FASTAGENT_API_KEY
--generate` does the same by hand and prints the key once. The report names the API's URL and the check:

```bash
fastagent invoke --url https://<app>.fly.dev "hello"
```

`invoke --url` reads the key from the same file; a program calls the deployment with
`connectAgent(url, { apiKey })` from `@fastagent-sh/fastagent/client`. To replace the key, list the new one first
(`FASTAGENT_API_KEY=new,old`), deploy, move the Callers, then remove the old one and deploy again. A definition whose
deployments should serve no API says `defaults: { http: { api: false } }` in `fastagent.config.ts`: `deploy` then writes no key,
and the deployment answers no `/v1` whatever key it holds, one an earlier deploy set on the host included. AgentCore
serves no API either way.

## Chat channels

A deployment receives its chat channels by webhook. On Fly, Railway and AgentCore the box points Telegram, Feishu and Lark (when
its config API allows) at its own URL on every start, with its own credentials: `deploy` delivers that URL as the
configuration's `http.publicUrl` (Fly's `https://<app>.fly.dev`; Railway's domain, created before `railway up`) unless
`--config` names one, a custom domain say, and `--run` reads what the box made of each one from its `/health`. Slack's
Request URL, which no credential on the box can change, is the person's to set (`--run` prints it). A URL only a person can set (Slack's; Lark's when its config API answers 404) the box confirms when the
platform reaches it there with an authenticated request, the verification on saving or any event; at a terminal with
`--config`, `--run` then records it in that file (`channels.<name>.app.url`), so later deploys of the file, CI
included, report it registered from the start. A deployment that did not record it:
`fastagent channels setup <name> --config <file> --url <its URL> --record-url`. Each run prints the steps it could not do.

On AgentCore the runtime has no `/health` of its own: it points its channels at the forwarder's URL (or `http.publicUrl`
when the configuration names one, a custom domain in front of the Function URL) on the first envelope the forwarder
relays after it starts, and `--run` reads the outcomes through the probe. A runtime a platform's request wakes does the
same, so every start points them again.

Docker has no public URL of its own: the Compose file publishes the agent on `127.0.0.1` only. Route your own
ingress (a reverse proxy, a named tunnel) to it and name that URL as `http.publicUrl` in the configuration `--config`
delivers, and the agent points Telegram and Feishu/Lark at it on every start (Slack's Request URL is yours to set);
or have the channel receive by `connection` where it has one, which needs no public URL. With `http.publicUrl`
named, `--run` ends by pointing at the agent's `/health` (each channel's outcome) and, for Slack, the Request URL to
set; without it, it says which paths receive nothing yet. It reads no outcome itself.

- **Independent dev and production apps.** `dev` reads `.secrets/.env`; `start` and `deploy` read
  `.secrets/production/.env`. Production never falls back to dev values. A deployment's values live on its target and are
  set with `fastagent secrets` (by default from that file; `--env-file` or `--from-env` name another source, and a prompt
  needs none), and never falls back to the dev file on its own; use
  `.secrets/.env.example` as a template, not the filled dev file.
- **Feishu/Lark receive by webhook on every host** unless the configuration `--config` delivers sets
  `channels.feishu.ingress` (`channels.lark.ingress`) to `"connection"`, while `dev` keeps WebSocket
  ([design note](design/channel-environments.md)): a host that scales to zero wakes on an inbound request. Interactive
  `--run` creates a separate production app when its credentials are missing: Feishu uses scan-to-create with the
  agent scopes plus `application:application:patch`; Lark uses guided console setup. App ID and Secret are saved
  immediately so an interrupted token capture resumes the same app. Approval and publishing remain console steps.
  `--run --json` hands the confirmation to a coding agent's user; without either a terminal or `--json`, `--run`
  stops (exit 2) naming it. CI must supply the production App ID, Secret and Verification Token beforehand.
- **Other channels:** run `channels setup slack --config prod.json` to create the
  production Slack app and keep its credentials, and the same for `telegram` with its own BotFather bot. A deployment
  receives by webhook, so each setup keeps what a webhook needs.
- **One app still delivers to one place.** `dev --tunnel` changes only the dev app's URL; `deploy --run` changes
  only production. Nothing refuses a production App ID copied from the default dev file: two instances on one app split its events, so give production an app of its own.

## Logging a deployment in

A model with no API key on the target (an account sign-in such as ChatGPT for `openai`, or a key you entered with
`fastagent login`) authenticates on the deployment itself:

```bash
fastagent login --deployment railway    # the host is always named
fastagent login openai --deployment fly
```

The host is not inferred from the agent directory: a Railway deploy leaves no file of its own there, and one
directory can hold several hosts' files.

`login --deployment`, `logs agentcore`, and `destroy agentcore` select the same production environment as `deploy`:
`.secrets/production/.env` supplies the host account, region, and proxy. `FASTAGENT_SECRETS_DIR` still overrides that
location, and shell variables still outrank file values.

The login runs on the box, through the host's own authenticated shell (`docker compose exec`, `fly ssh console`,
`railway ssh`, or AgentCore's `InvokeAgentRuntimeCommandShell` signed with your AWS CLI credentials). This terminal
shows its prompts and opens the browser. After you sign in, the browser returns to a `localhost` address; this
terminal catches it and hands it to the box. If that port is taken (a local login in progress, another app), it
says so, and you paste the address the browser landed on instead. The box exchanges the code and keeps the
credential on its storage, so it is the only holder of that grant: your machine's login is untouched, and neither
side can log the other out. Logging in again replaces it.

A coding agent runs `fastagent login <provider> --method account --deployment <host> --json`. It answers at once with
the sign-in's address (and a device code) for its user, and a ticket: a process of its own holds the box's shell,
catches the browser's return to `localhost` on this machine, and takes the address from `login --check <ticket>
--code <address>` when the browser is elsewhere. `login --check <ticket>` reports `done` once the box holds the login.
For an API key it names the variable to set on the target (`fastagent secrets set <host> <NAME>`);
the box uses it unless it already holds an account sign-in for that provider, which outranks it (below).

`deploy --run` asks the box once it answers `/health` and before it reads the webhooks' outcomes: the box keeps a
credential it already authenticates the model's provider with (a login it holds, unexpired or refreshable; a
variable its host sets; a role it runs as), and logs in only when it has none. A redeploy therefore keeps the box's
credential. A credential revoked at the provider before it expires is not detected, and the first turn fails with
the provider's error: run `fastagent login --deployment <host>` to replace it. With `--json`, the login is a step of
the deploy's ticket, and the deploy reads what the box made of its webhooks once it is done. Without a terminal or `--json` (CI), `--run`
stops at the login with `not logged in`, exit 1, naming the command for a terminal and the `--json` one for a coding
agent. It has confirmed no webhook at that point (a box that points its own channels may have pointed them already, and
a message that reaches it fails until the login), so when the agent has any, the message also says what to re-run once
the box is logged in.

A login stored on the box outranks a key in its environment (pi lets a stored credential own its provider). So a key
added to `.secrets/production/.env` after the box was logged in is not used; the box's startup log says so and names the
command that switches it to the key (`fastagent login <provider> --deployment`, choosing "API key").

Until it is logged in, the box is already running: a long-connection channel (a Feishu/Lark WebSocket) is connected
and schedules fire, and each turn they start fails for want of a model credential. Only webhooks wait for
the login. For an unattended first deploy of such an agent, use an API key.

When the credential is missing or rejected later (revoked, volume lost), the box's startup log names
`fastagent login --deployment <host>`, with its host filled in on Fly, Railway and AgentCore (read from what each
platform sets in the box's environment). A Docker box cannot tell, and leaves `<host>` for you to fill in.

- **Railway** needs Railway CLI 5.x on `PATH`: 4.x's `railway ssh` goes through an SSH-key gateway and answers with a
  signup URL instead of opening the shell (`railway --version`; an old Homebrew copy can shadow the installer's).
- **AgentCore** resets its storage on every deploy and after 14 idle days, and the login with it. Every deploy of an
  agent that logs in ends with this login; after an idle reset every turn fails until you run
  `fastagent login <provider> --deployment agentcore` again (the runtime's log names it). An agent that must keep
  answering unattended needs an API key there. Without a terminal or `--json`, `deploy agentcore --run` therefore
  stops before building anything, rather than replace a serving runtime with one nobody can log in; with `--json`
  the login is a step of the same ticket. For frequent or CI deploys, use an API key. The shell needs
  `bedrock-agentcore:InvokeAgentRuntimeCommandShell`, and the login first sends the runtime a probe so its storage
  is prepared (after a reset, nothing may have invoked it yet). The shell does not inherit the runtime's environment, so
  an egress proxy in the deployment's values (`HTTPS_PROXY`) applies to the agent's turns but not to the login: where the
  provider is reachable only through that proxy, use an API key on AgentCore.

## Local Docker

Requires Docker Compose 2.3.3 or newer.

```bash
fastagent deploy docker
```

Generates `Dockerfile`, `.dockerignore` and `fastagent.compose.yml` in the agent directory, with one `agent`
service:

- the generated or your own Dockerfile,
- `127.0.0.1:<port>` published on the host,
- a named volume at `/data`,
- `env_file: .secrets/production/.env` (a fixed path, created empty when missing), with `FASTAGENT_STATE_DIR`,
  `FASTAGENT_SECRETS_DIR`, `FASTAGENT_AUTH_PATH` and `PORT` pinned after it,
- `restart: unless-stopped`.

```bash
docker compose -f fastagent.compose.yml build --pull
docker compose -f fastagent.compose.yml up -d
docker compose -f fastagent.compose.yml logs -f agent
docker compose -f fastagent.compose.yml ps
docker compose -f fastagent.compose.yml down     # keeps the state volume
docker compose -f fastagent.compose.yml down -v  # destructive: deletes all state
```

`--run` checks Docker and the daemon, gates missing values before building, refuses when another process already
serves the host port the agent publishes (a `/health` answered there would not be the agent's; a container this
project already runs keeps its own port), builds with `--pull` (the base image is a floating tag) and runs `up -d`,
checks the services, and waits for `/health`. Nothing passes through Compose's environment: the container reads
`.secrets/production/.env` itself.

Notes:

- Compose expands `$VAR` inside `env_file` values, so a value containing `$` reaches the container changed.
  `deploy` warns. `$$` fixes Compose but breaks every other reader of the file; prefer a value without `$`.
- If `FASTAGENT_SECRETS_DIR` points this machine at a different value file than the committed Compose reads,
  generating warns and `--run` gates.

### Owning the Docker files

- An existing `Dockerfile`, `.dockerignore` or `fastagent.compose.yml` is kept byte for byte and used by `--run`.
- `--force` regenerates only files fastagent generated (they start with a marker line). Remove the marker to own a
  file; delete a file to hand it back.
- The environment (`context.json`'s `environment`) is installed by the generated Dockerfile; a hand-written one
  installs it only if it says so, and `deploy` warns.
- `--run` relies on the service named `agent`. Add other services, networks, volumes or ports freely.

## Fly.io

Requires [flyctl](https://fly.io/docs/flyctl/install), signed in: `--run` runs `fly auth login` when it is not (at a
terminal, or for a coding agent's person with `--json`). A token goes in your shell's or CI's environment
(`FLY_API_TOKEN`), not in `.secrets/production/.env`, which holds the deployment's values.

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

Requires the [Railway CLI](https://docs.railway.com/guides/cli), signed in: `--run` runs `railway login` when it is
not, as for Fly. A token (`RAILWAY_API_TOKEN`) goes in your shell's or CI's environment, never in
`.secrets/production/.env`.

```bash
fastagent deploy railway
```

Generates `Dockerfile` and `.dockerignore`, and prints the runbook:

1. `railway init` (or `railway link`).
2. `railway add --service <name>`.
3. `railway volume add --mount-path /data`.
4. `railway variables set FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets …` before the
   first deploy.
5. `railway up`. For a new release, run `fastagent deploy railway` first.
6. `railway domain`, then register webhooks.

```bash
fastagent deploy railway --run   # provisions an unlinked dir end to end, and redeploys a provisioned one
```

`--run` continues the linked project named for the agent (`fastagent secrets set railway` and an earlier `--run` make
one) and gives it the service when it lacks one. It refuses a dir linked to any other project, whatever that project
holds, unless `--into-linked`; `fastagent secrets … railway` refuses it too. No Railway config file is generated:
Railway retires `railway.json` on 2026-12-01, and its replacement (`.railway/railway.ts`) would make every agent
install Railway's SDK. Railway builds the `Dockerfile` at the root of the upload and restarts a crashed service by
default. It does not wait for `/health`, so it marks a deploy live once the container starts; `--run` probes the
public `/health` itself before it logs the box in or points a webhook at it, and `railway logs` shows a box that
crashes on boot.

## Scale to zero

| Definition has | Fly (`min_machines_running`) / Railway (App Sleeping) |
|---|---|
| a schedule (`src/schedules/`) | kept up: the schedule is the agent's own clock, and nothing wakes a stopped machine at its instant |
| a long-connection channel | kept up; an outbound connection cannot wake a stopped machine |
| neither | may scale to zero |

A clock that must wake a scaled-to-zero machine is a channel of your own: a route the clock calls (Fly Cron Manager, a
Railway cron service, a CI job), which verifies the clock's call (a shared secret compared with `secretEquals`) and
sends the agent its message, or the Agent API, called with a key (`POST /v1/sessions/{sessionId}/messages`) when the
deployment serves it ([Configuration](configuration.md#the-agent-api-over-http)).

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

Generates `agentcore.template.yaml`, `lambda/index.js`, container files and a release manifest.
The runbook: create the ECR repository and the values secret, `docker buildx build --platform linux/arm64 … --push` with a unique tag
per deploy, `aws cloudformation deploy`, read the outputs, register webhooks. `--run` does all of it.

The stack carries:

- the **Runtime** (your container; `FASTAGENT_AGENTCORE=1` serves `POST /invocations` and `GET /ping`);
- a **forwarder Lambda** with a public Function URL: it relays webhooks when a webhook channel exists (channels
  verify signatures as on every host), tells the container where it is (the URL the container points its webhook
  channels at) and manages the EventBridge schedules below;
- **EventBridge schedules**, which the container sets itself: one recurring cron schedule per schedule, which
  EventBridge fires on its own clock, and a self-deleting one-shot per pending wake-up. Both wake the container on
  time. The container sets them once an envelope has
  reached it through the forwarder, which tells it where the forwarder is: `--run` does this with its probe; after a
  manual deploy, `POST <ForwarderUrl>/__fastagent/probe` with `{"auth":"<FastagentIngressSecret>"}` once (the runbook
  prints it). An `invoke-agent-runtime` call does not, since that door is IAM's and carries no forwarder address.

The deployment's values are one **Secrets Manager secret**, `fastagent/<name>`, a JSON object of NAME → value. It is made
outside the stack, like the ECR repository and the bucket, so the values exist before the first deploy and a stack
update never rewrites them. The stack gets its ARN as a parameter, the runtime's role may read that one secret, and the
container reads it with the role's credentials on its first invocation, so adding a name changes neither the template
nor the stack. `fastagent secrets list|set|push agentcore` and `deploy agentcore --run` fill it the way they fill the
other hosts' stores; a failed read fails that invocation, so `--run`'s probe reports it. A session already running keeps
the values it read until it ends (its idle timeout) or the next deploy. The command that runs `--run` needs
`secretsmanager:CreateSecret`, `DescribeSecret`, `GetSecretValue` and `PutSecretValue`, and `destroy` also
`DeleteSecret`. The secret costs about $0.40 a month, even with no value in it.

### The permissions a deployer needs

`deploy agentcore --run`, a redeploy, `logs agentcore`, `secrets … agentcore`, `login <provider> --deployment agentcore`
(up to the box's own sign-in) and `destroy agentcore` ran end to end as an IAM user holding only this policy (replace
`<region>` and `<account-id>`; as a customer managed policy, since an inline user policy is capped at 2048 bytes). Every
resource is scoped to the names a deploy derives (`fastagent-*`, `fa-*`, `fastagent/*`); CloudFormation makes the stack's
calls with the caller's own permissions, which is why Lambda, IAM and AgentCore actions are here. Without
`bedrock-agentcore:InvokeAgentRuntimeCommandShell` the login stops naming it. The `Iam` statement lets its holder create
any role named `fastagent-*` with any permissions and hand it to a function they create (`CAPABILITY_IAM`), so treat this
principal as able to escalate within the account; a permissions boundary on those roles would narrow that, and was not
tried. It is a verified set, not a proven minimum.

Before it builds anything, `deploy agentcore --run` looks for the service-linked role the runtime needs
(`AWSServiceRoleForBedrockAgentCoreRuntimeIdentity`, the `SlrRead` statement, which names the role with and without its
`/aws-service-role/…/` path: IAM cannot know the path of a role that does not exist yet, and authorizes the read of an
absent role against the name alone) and creates it when the account has never
used AgentCore (the `Slr` statement). It reads first, since IAM authorizes `CreateServiceLinkedRole` before it says the
role exists, and a deployer without that permission would otherwise be refused in every account that already has it.
Without the permission and without the role it stops there, naming the command for someone with IAM rights to run
(`aws iam create-service-linked-role --aws-service-name runtime-identity.bedrock-agentcore.amazonaws.com`); if it cannot
read the role either, it warns and goes on.

What was measured, in an account that had never used AgentCore (a first `deploy agentcore --run --no-input` as an IAM user
holding only this policy): with `Slr`, the check created the role and the deploy went through to a verified runtime; with
the policy minus `Slr`, it stopped in 8 seconds, before anything was built or made, with IAM's refusal and the command
above. Without `SlrRead` naming the role without its path the read of the absent role is refused, the check only warns,
and CloudFormation creates the role itself (it does so when the caller may). `network.bedrock-agentcore.amazonaws.com` is
probably not needed for what `deploy agentcore` generates (`NetworkMode: PUBLIC`: a deploy in an account without that
role neither created it nor called for it) and stays as the one a VPC mode would use.

```json
{"Version":"2012-10-17","Statement":[
  {"Sid": "Cfn", "Effect": "Allow", "Action": ["cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DeleteStack", "cloudformation:GetTemplateSummary"], "Resource": "arn:aws:cloudformation:<region>:<account-id>:stack/fastagent-*/*"},
  {"Sid": "CfnGlobal", "Effect": "Allow", "Action": ["cloudformation:GetTemplateSummary", "cloudformation:ListStacks"], "Resource": "*"},
  {"Sid": "Iam", "Effect": "Allow", "Action": ["iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PassRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UpdateAssumeRolePolicy"], "Resource": "arn:aws:iam::<account-id>:role/fastagent-*"},
  {"Sid": "Lambda", "Effect": "Allow", "Action": ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy", "lambda:CreateFunctionUrlConfig", "lambda:DeleteFunctionUrlConfig", "lambda:GetFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig", "lambda:ListTags", "lambda:TagResource"], "Resource": "arn:aws:lambda:<region>:<account-id>:function:fastagent-*"},
  {"Sid": "LambdaGlobal", "Effect": "Allow", "Action": ["lambda:GetAccountSettings"], "Resource": "*"},
  {"Sid": "AgentCore", "Effect": "Allow", "Action": ["bedrock-agentcore:CreateAgentRuntime", "bedrock-agentcore:UpdateAgentRuntime", "bedrock-agentcore:DeleteAgentRuntime", "bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:ListAgentRuntimes", "bedrock-agentcore:ListTagsForResource", "bedrock-agentcore:TagResource", "bedrock-agentcore:CreateWorkloadIdentity", "bedrock-agentcore:DeleteWorkloadIdentity", "bedrock-agentcore:GetWorkloadIdentity", "bedrock-agentcore:StopRuntimeSession", "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:UpdateAgentRuntimeEndpoint", "bedrock-agentcore:DeleteAgentRuntimeEndpoint", "bedrock-agentcore:ListAgentRuntimeEndpoints", "bedrock-agentcore:UntagResource", "bedrock-agentcore:PassCapacityProvider", "bedrock-agentcore:InvokeAgentRuntimeCommandShell"], "Resource": "*"},
  {"Sid": "EcrAuth", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
  {"Sid": "Ecr", "Effect": "Allow", "Action": ["ecr:CreateRepository", "ecr:DescribeRepositories", "ecr:DeleteRepository", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], "Resource": "arn:aws:ecr:<region>:<account-id>:repository/fastagent/*"},
  {"Sid": "S3", "Effect": "Allow", "Action": ["s3:CreateBucket", "s3:PutBucketPublicAccessBlock", "s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation", "s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteBucket"], "Resource": ["arn:aws:s3:::fa-*", "arn:aws:s3:::fa-*/*"]},
  {"Sid": "Secrets", "Effect": "Allow", "Action": ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"], "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:fastagent/*"},
  {"Sid": "Logs", "Effect": "Allow", "Action": ["logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents", "logs:DeleteLogGroup", "logs:PutRetentionPolicy"], "Resource": "*"},
  {"Sid": "Scheduler", "Effect": "Allow", "Action": ["scheduler:ListSchedules", "scheduler:GetSchedule", "scheduler:DeleteSchedule"], "Resource": "*"},
  {"Sid": "SlrRead", "Effect": "Allow", "Action": "iam:GetRole", "Resource": ["arn:aws:iam::<account-id>:role/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity", "arn:aws:iam::<account-id>:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity"]},
  {"Sid": "Slr", "Effect": "Allow", "Action": "iam:CreateServiceLinkedRole", "Resource": "*", "Condition": {"StringEquals": {"iam:AWSServiceName": ["runtime-identity.bedrock-agentcore.amazonaws.com", "network.bedrock-agentcore.amazonaws.com"]}}}
]}
```

What to know:

- **Idle cost.** A session keeps its microVM for `deploy.agentcore.idleTimeoutSeconds` (default 180) after it goes  idle, and memory bills for that time; after it, the next message cold-starts. `/ping` reports `HealthyBusy`
  while any message is not yet settled, so work is not cut short.
- **Every deploy resets the state.** Managed SessionStorage survives compute stop/resume but is wiped on every
  runtime update (every deploy) and after 14 idle days: sessions, channel state and pending wake-ups start blank.
  For state that survives deploys, use Fly or Railway.
- **A login on the runtime survives neither reset**: not a deploy, and not 14 idle days. `--run` logs the runtime in
  again after every deploy and refuses to start without a terminal to do it in; after an idle reset, nothing does it
  for you and turns fail until `fastagent login <provider> --deployment agentcore`. A provider API key in
  the deployment's secret (`fastagent secrets set agentcore <its variable>`) avoids all of it.
- **Nothing opens before the first invocation.** `--run` probes that path, so a bad credential or a broken channel
  fails the deploy with the runtime's error.
- **Redeploys stop the runtime session** so the next call uses the new image; in-flight work is lost.
- **No long-connection channels.** Feishu/Lark receive by webhook here by default; a delivered configuration setting
  `channels.<name>.ingress` to `"connection"` makes `--run` refuse.
- **The IAM-gated door takes only a probe.** `InvokeAgentRuntime` with the deployment's fixed `runtimeSessionId`
  (printed in the runbook) answers whether the definition opened; the agent is reached through its channels and
  schedules.
- **Webhook bodies over about 4 MiB** cannot pass the Lambda Function URL (6 MB request cap).
- **A kept template that no longer matches the definition** (a new channel) stops `--run` until
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

Deletes the stack, the artifact bucket, the ECR repository, the values secret (without a recovery window, since one
would keep its name from the agent's next deployment), both log groups and pending wake alarms, which
`aws cloudformation delete-stack` alone leaves behind. It prints the account and region first. A read it cannot
complete stops the command. A stack that does not reach `DELETE_COMPLETE` stops the rest.

It leaves the account's `AWSServiceRoleForBedrockAgentCoreRuntimeIdentity` role in place, one a first deploy created
included: the role belongs to the account and any other AgentCore runtime uses it. It costs nothing; remove it with
`aws iam delete-service-linked-role --role-name AWSServiceRoleForBedrockAgentCoreRuntimeIdentity` once nothing uses it.

- Conversations are deleted with the stack. A bucket holding anything besides forwarder packages is kept and
  reported.
- Webhook registrations on Telegram, Slack or Feishu are not removed. Clear them yourself (Telegram:
  `curl "https://api.telegram.org/bot<token>/deleteWebhook"`).

## What deploy bakes

The agent directory is the build context: the image holds it at `/app/definition`, minus what the ignore file
excludes, and builds its `dist/` there. The deployed agent runs that build where the image has it, and its working
directory is the persistent storage:

```text
<persistent-root>/        # the agent's working directory: what it writes lands here, and stays across releases
├── .state/               # agent.sqlite (sessions and messages), channels, scheduled work, mise's data directory (mise/)
├── .secrets/             # credentials, including refreshed auth.json
├── content/              # the agent's content: clones of its github entries
└── .deployment/          # the lease, and the release last started here
```

- Every `fastagent deploy <host>` writes a new release id to `fastagent.release.json`, and the packages the image
  installs to `fastagent.packages`, empty without any (both rewritten every time; do not edit them). A new release
  replaces the image, and so the definition; everything on the storage stays. The agent's definition is read as the
  image built it: a change it makes to a copy in its working directory is not read.
- A file lock at `.deployment/lock` excludes competing starters; do not delete it. Custom images need `flock`. A
  storage another agent's deployments started on is refused.
- Storage an earlier FastAgent laid out may hold a `definition/` (or `base/`) directory: it is left as it is, and no
  longer read.
- The agent's `package.json` dependencies install at build time; keep the deploy CLI and the agent's FastAgent
  dependency on the same version.
- `SYSTEM.md`, `AGENTS.md`, skills and prompt templates are read for every message; code under `src/` and config
  need a restart.

**The environment**: with [packages](configuration.md#environment) declared, `deploy` lists them in
`fastagent.packages`, and the image copies that file and installs each package at the newest release its version allows,
with the agent's own mise, in a layer that is rebuilt only when the packages or the dependencies change. The packages go
to mise's system directory (`/usr/local/share/mise`), so a start on the host downloads nothing. The agent's
`aptPackages` join the image's apt layer. `deploy` checks the packages as `fastagent env add` does, and installs nothing
here. `--run` stops when `package.json` does not list mise, when mise is not installed here to check the packages (run
`fastagent env install`), on a package whose backend FastAgent refuses, or on a PyPI package without `python` and `uv`
declared; without `--run`, these are warnings. Chromium with CJK fonts adds about 1 GB to the image. The
[variables](configuration.md#environment) `context.json` declares are required like a module's secrets: the runbook lists
each with its description, and a deploy whose target has no value for one stops before it builds anything.

**Artifacts** land in the agent directory: `Dockerfile`, `.dockerignore` and `Dockerfile.dockerignore` (the same
rules; BuildKit prefers the one beside the Dockerfile), and `fastagent.compose.yml` / `fly.toml` /
`agentcore.template.yaml` (Railway has none of its own). The ignore file excludes `.secrets` contents (except `.env.example` and `.gitignore`),
`**/.state`, `/.fastagent`, `/content`, `**/node_modules`, `**/.cache` and `**/.env*`, and keeps `.git`.

- Generated artifacts start with a marker line. `--force` regenerates only those; a file without the marker is
  never touched.
- A generated artifact that no longer matches the definition is kept and reported, and gates `--run`.
- A kept ignore file that drops `fastagent.config.ts`, or does not exclude `.secrets/auth.json` or `content`, gates
  `--run`; an unexcluded `.state` or `node_modules` warns.

**Git**: when the agent directory is a repository, `git` is installed and its `.git` ships with the definition. Some
host CLIs strip `.git` (`railway up` does). An agent that needs git without that declares it:
`fastagent env add apt:git`.
Add `.git` to `.dockerignore` for a smaller image.

## Other Docker hosts

The generated `Dockerfile` runs on any container platform. Supply a persistent volume, the variables, and, for
route channels, public ingress and webhook registration. A long-connection channel needs an always-on process.

## Single-machine tier

Resident deployments need **one active replica** with durable storage: one process holds an instance's storage at a
time, and a second is refused. Spreading one instance over several processes needs a router that sends each session's
calls to the process holding it ([architecture.md](design/architecture.md) §4.3); it is not built.

## Where next

- [CLI reference](cli.md)
- [Configuration](configuration.md)
- [Channels](channels.md)
