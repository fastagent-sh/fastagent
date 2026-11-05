---
title: A channel's platform app, set up per instance
description: "`add` changes the program; `channels setup` binds an instance to its Slack, Feishu, Lark or Telegram app, keeps each credential with its holder, and syncs the app's platform configuration."
type: design-doc
status: proposed
updated: 2026-10-12
---

# A channel's platform app, set up per instance

**Status: proposed (#900, stage C).** Not implemented. Where this and the code disagree, the code is current behavior
and this is the target. It changes [channel-environments.md](channel-environments.md) §3–§4 and builds on
[agent-artifact.md](agent-artifact.md) §6.2 (a deployment's values are the target's state).

## 1. The problem

A channel touches three things, and since the artifact work they have different owners and lifetimes:

| Layer | What it is | Owner, lifetime |
|---|---|---|
| Program | `src/channels/<name>.ts`, its companion tools, the names it declares | The author; in git, built, published |
| Instance | Its configuration (`channels.<name>.ingress`, `http.publicUrl`), its values, its state | Whoever runs it; one per instance |
| Platform app | The Slack app, Feishu or Lark app, Telegram bot, and its settings on the platform (Request URL, events, scopes) | Bound to exactly one instance (two receivers on one app split or steal its events) |

`fastagent add <channel>` does all three today: it scaffolds the file, creates or resumes the app, writes credentials
to the dev or production value file (`--env`), writes the way of receiving (`--ingress`, `--config`), and keeps the
Slack app's configuration tokens in the state root. That conflation shows up as soon as the program travels without
its source: someone who installs `@acme/reviewer` from npm has an instance and needs their own app, and has no
command to get one; and a production app's record sits in a laptop's `.state/production`, which is not the production
instance's state.

## 2. Two commands

- **`fastagent add <channel>` changes the program only.** It writes the channel file and its tools and declares their
  names in `.secrets/.env.example`. It creates no app, writes no value and no instance configuration. Its flags
  `--env`, `--ingress`, `--config`, `--no-onboard` and `--replace-config` go. At a terminal it then runs
  `channels setup <channel>` for the **development** instance, so one command still leaves a working dev bot;
  `--no-setup` skips that. With no terminal, and with `--json`, it changes the program only and names
  `fastagent channels setup <channel> --json` in its next steps: the person's part of a setup is that command's
  ticket, never `add`'s. A production instance is never set up through `add`.
- **`fastagent channels setup <name>` sets up one instance's app**, and is safe to run again: every run syncs.
  - It creates the app (Slack's manifest API, Feishu's scan-to-create, Lark's guided console, Telegram's BotFather by
    hand), or links an existing one (`--app <id> --team <id>` for Slack).
  - It writes the app's runtime credentials to the instance's store: dev's `.secrets/.env`, a host's store
    (`--host fly`, through `fastagent secrets`, agent-artifact.md §6.2), or `--env-file <file>`.
  - It writes the instance configuration the file `--config` names (dev's `fastagent.json` by default): the binding
    (§4) and `channels.<name>.ingress` when given `--ingress`.
  - It syncs what only an operator can sync (§5).
  - It runs from a built package as from a project (`npx @acme/reviewer channels setup slack --config prod.json
    --host fly`), and in a coding agent's run as a ticket (`--json`, `need_user_action`).
- **`deploy`** checks names only (§6.2). For a channel whose names the target lacks it runs `channels setup` for that
  target at a terminal, hands it to the ticket's person with `--json`, and stops naming the command with nobody to
  ask. The Feishu production-app creation moves from `deploy` into `channels setup`.

## 3. Who performs each operation

Three parties: the **instance** (the serving process, on the box), the **person's machine** (where someone runs the
CLI), and **CI**.

| Platform | Operation | Needs | Performed by |
|---|---|---|---|
| Telegram | Create the bot | BotFather | Person |
| | Receive, send, `setWebhook` | Bot token, secret token | **Instance**, registering itself (§5) |
| Feishu | Create the app | Scan-to-create (device authorization); nothing is kept | Person |
| | Receive, send; set the Request URL (v7 PATCH); check scopes | **App ID and App Secret**, the app's own | **Instance** |
| | Capture the Verification Token | No read API; only the `url_verification` challenge | Person's machine, at setup, through a throwaway tunnel, and only when the store has none |
| | Tenant approval, version publish | The console only | Person (the instance reports `manual`) |
| Lark | Create the app | Guided console, credentials pasted; nothing is kept | Person |
| | Set the Request URL | The config API often answers 404 | Instance tries; on 404 it reports `manual` |
| Slack | Receive, send | Bot token, signing secret | Instance |
| | Create the app; sync the manifest (Request URL, scopes, events) | An **App Configuration token**: a person's developer credential, per workspace, rotating every 12 hours with a refresh token that changes on each use | **Person's machine** |
| | Install or reinstall (new scopes) | Client ID and secret, and a person's Allow | Person |

The Feishu Verification Token is captured at setup and not by the instance registering itself: the instance's URL is
public and stable, so accepting the first challenge's token there would let anyone who posts a forged challenge first
plant theirs; the throwaway tunnel's URL is random and lives for one capture.

Capturing re-points the app's Request URL at the tunnel, so it must not run against an app that is serving: setup
captures only when the instance's store has no Verification Token, and afterwards sets the Request URL to
`http.publicUrl` when the configuration has one, or says that the instance re-points it when it next starts. A run
that only re-syncs leaves the URL alone.

## 4. Where each record lives

The Slack onboarding record (`<state root>/channels/slack/onboarding.json`) holds data with four different owners, and
the state root is wrong for all of them: state is what the serving process writes, lives where it runs, and may be
reset (AgentCore on every deploy; `start --root <empty>` to reproduce). The record is read by the setup on a person's
machine, describes a production instance from a laptop, and once lost leaves no way to know which app was bound.

| Data | Nature | Lives in |
|---|---|---|
| Which app: Slack `appId`, `teamId`, and the digest of the manifest last synced | The instance's binding; not secret; must survive a state reset; shared by everyone who operates the instance | **Instance configuration**: `channels.<name>.app: { id, team, manifest }`, delivered with `--config` (Slack CLI's `apps.json`) |
| Slack signing secret and bot token; Feishu and Lark App ID, App Secret, Verification Token, Encrypt Key; Telegram bot and secret tokens | Runtime credentials | **The instance's store** (agent-artifact.md §6.2) |
| Slack configuration token, its refresh token and expiry | A person's developer credential for one workspace; one holder; never on a box | **The person's credential store**: `~/.fastagent/.secrets/slack.json`, by team ID, owner-only (beside the machine's model credentials, `~/.fastagent/.secrets/auth.json`) |
| Slack client ID and secret, `createAttemptedAt`, `installedAt` | What setup needs to install again and to resume | The person's credential store, by app ID |

`channels.<name>.app` is Slack's only: `id` is the app ID, `team` the workspace's team ID, and `manifest` the digest of
the manifest last synced; the configuration refuses it on a channel that is not a Slack one.

Feishu, Lark and Telegram keep nothing on the person's machine: creation leaves no developer credential, and the
App ID and Secret are the instance's. The Feishu App ID is not secret, but it stays in the store, read with the
secret.

The project's root `fastagent.json` is the **development instance's** configuration, and a development app is one
person's (two developers on one dev app take each other's messages). So it is personal: the scaffold's `.gitignore`
lists it, as Slack CLI keeps `apps.dev.json` out of git, and what a team shares goes in the program's `defaults` or a
shared deployment configuration (`prod.json`). `content add`'s directory entries, which are machine paths, already
made it one.

The person's credential store is a replaceable port, as model credentials' `CredentialStore` and MCP's grant store
are: an embedding app passes its own (a Keychain). Where it runs:

| Where setup runs | Its developer credential |
|---|---|
| A laptop, deploying to local Docker, Fly, Railway or AgentCore | `~/.fastagent/.secrets/slack.json` |
| CI | Not needed in the common case (§5) |
| A server that runs the agent too | `--no-save`: used for the run and not written, since the agent runs as the same user with a shell |
| An embedding app | The app's own store |
| A deployed box | Never |

A development agent on a laptop can read `~/.fastagent/.secrets/`, as it can `~/.ssh`; documented, not new.

## 5. Keeping the platform pointed at the instance

**Telegram, Feishu and Lark: the instance registers itself.** Once it listens, the serving process points each webhook
channel at its public URL, and sets it on every start rather than reading it first: Telegram's `getWebhookInfo` does
not return the `secret_token`, so a rotated secret behind an unchanged URL would read as nothing to do and every update
would then be refused; Feishu's v7 configuration route accepts only a PATCH. Both calls are idempotent. Frameworks do
the same at startup (python-telegram-bot's `run_webhook`). A restart repairs a URL or secret that drifted, and
`dev --tunnel` already works this way, so dev and production share the path.

- **The public URL is an explicit input, never inferred** from the environment, because the same package runs
  embedded under a prefix (`https://x.fly.dev/agent`) and on laptops holding production credentials, where a guessed
  URL would point the bot at the wrong place:
  - `http.publicUrl` in the configuration, the full base including any mount prefix. `deploy` writes it into the
    configuration it delivers when it knows it before the build: Fly (`https://<app>.fly.dev`), Railway (the domain
    created before `railway up`, to verify).
  - AgentCore: the forwarder, which resolves its own Function URL already, carries it in its probe envelope.
  - Docker with `--tunnel`: read from the generated cloudflared service's metrics (`/quicktunnel`, to verify).
  - None: nothing is registered, and the outcome says so with the URL to use.
- **The library makes it a step of its own:** `service.listen()` registers when `http.publicUrl` is set; an app that
  mounts `service.fetch` calls `service.registerWebhooks()` once it listens. Both return each channel's outcome
  (`registered`, `manual` with the step for a person, `failed`). A SPEC change of its own.
- **`start` reports the outcome in `/health`**: each channel kind and its outcome, nothing else; the details go to the
  log. `deploy` reads it and applies the registration gate it applies today.

**Slack: the person's machine syncs, and only when something changed.** The Request URL is app configuration that a
bot token cannot change.

- `channels setup slack` builds the manifest from the program (the channel's scopes and events) and the instance (the
  app's name, `http.publicUrl`), syncs it with the configuration token, and records its digest in the binding (`channels.<name>.app.manifest`).
- Before overwriting, it compares the manifest on Slack with the one it last synced; a change made in the Slack console
  is asked about at a terminal, handed to the person with `--json`, and stops otherwise (Slack CLI asks the same).
- `deploy`, CI included, computes the manifest this deployment needs and compares it with the recorded digest. Equal,
  which is every redeploy that changes neither URL nor channel: nothing to report and no credential needed. Different:
  `manual`, naming what changed and the `channels setup slack --config …` to run on a machine logged in to Slack.
- The instance checks at start the scopes it holds (Slack's `x-oauth-scopes` header on any call) and warns of a
  missing one, as the Feishu channel does.
- When the URL is known only after a first deploy (Railway, AgentCore), the interactive first deploy syncs once it
  has it.

## 6. What the platforms recommend

Each platform recommends a connection the app opens for development and webhooks for a deployment, which is the
default `byIngress` takes (`dev`: `connection`; everything else: `webhook`):

- **Slack**: Socket Mode while developing; HTTP Request URLs once deployed, for reliability (Socket Mode's backend
  recycles connections) and required by the Slack Marketplace; on Lambda, acknowledge only after the work is safe
  (`processBeforeResponse`).
- **Feishu and Lark**: the long connection for self-built apps, deployable too; "if you deploy in a FaaS model,
  send events to the developer's server". Store apps receive by webhook only.
- **Telegram**: long polling on a machine that runs all the time; webhooks are required on serverless hosts.

Runtime credentials live in the host's environment in each platform's own deployment guides.

## 7. Borrowed from Slack CLI, not depended on

Slack CLI (v3, Bolt apps) keeps one app per project and environment (`.slack/apps.dev.json` personal,
`.slack/apps.json` shared), links an existing app (`slack app link`), treats the manifest as the source of truth
synced on every run and deploy, and asks before overwriting a change made in app settings. FastAgent takes those ideas
per **instance** rather than per project. It does not depend on the CLI: it is a separate Go binary installed outside
npm, its records live in a project directory that an npm-installed agent does not have, it starts the app itself
through hooks, and its login is its own.

## 8. Known risks

- On a host that scales to zero, a process must not be frozen between acknowledging an event and finishing the turn.
  AgentCore keeps a busy session (`HealthyBusy`); Fly Sprites and Railway Serverless must be checked before FastAgent
  supports them.
- CI cannot sync a Slack manifest: the configuration token rotates, and a Slack CLI service token is not accepted by
  `apps.manifest.update`. It is needed only when the URL or the channel changes (§5).

## 9. Later

- `connection` for Slack (Socket Mode) and Telegram (long polling) in development: no tunnel, and no Request URL that
  moves on every `dev`.
- The OS keychain for every credential FastAgent keeps (model, MCP grants, Slack), decided with where credentials live.
- A Slack manager app for unattended syncs, should CI need one.

## 10. Delivery

1. The SPEC change: `http.publicUrl`, `InstanceConfig.channels.<name>.app`, `service.registerWebhooks()` and its
   outcome.
2. The instance registering itself (Telegram, Feishu, Lark), the URL sources, `/health`'s outcome.
3. `channels setup` and `add` changing only the program; Feishu production-app creation out of `deploy`; the Slack
   records moved (§4); `fastagent.json` in the scaffold's `.gitignore`.
4. `deploy` comparing the Slack manifest digest.
