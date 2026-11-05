---
title: A channel's platform app, set up per instance
description: "`add` changes the program; `channels setup` binds an instance to its Slack, Feishu, Lark or Telegram app, keeps each credential with its holder, and the platform stays pointed at the instance with no developer credential."
type: design-doc
status: proposed
updated: 2026-11-05
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
  names in `.secrets/.env.example`. It asks nothing, creates no app, writes no value and no instance configuration.
  Its flags `--env`, `--ingress`, `--config`, `--no-onboard` and `--replace-config` go. Its next steps name
  `fastagent dev`.
- **`fastagent dev` sets up what the development instance lacks, the first time.** Before it opens the instance, a
  channel whose names the development value file lacks is set up then and there at a terminal (`channels setup
  <name>`), as `slack run` creates and installs a local app on first run; usually once per project. With no terminal
  it refuses as it does today for a missing value, naming `fastagent channels setup <name> --json`.
- **`fastagent channels setup <name>` sets up one instance's app**, and is safe to run again.
  - It creates the app (Slack's manifest link, Feishu's scan-to-create, Lark's guided console, Telegram's BotFather
    by hand), or links an existing one (`--app <id>`).
  - It writes the app's runtime credentials to the instance's store: dev's `.secrets/.env`, a host's store
    (`--host fly`, through `fastagent secrets`, agent-artifact.md §6.2), or `--env-file <file>`. A credential the
    person has is pasted: hidden input at a terminal, a page on this machine with `--json`, never the conversation.
  - It writes the instance configuration the file `--config` names (dev's `fastagent.json` by default): the binding
    (§4) and `channels.<name>.ingress` when given `--ingress`.
  - It runs from a built package as from a project (`npx @acme/reviewer channels setup slack --config prod.json
    --host fly`), and in a coding agent's run as a ticket (`--json`, `need_user_action`).
- **`deploy`** checks names only (§6.2). For a channel whose names the target lacks it runs `channels setup` for that
  target at a terminal, hands it to the ticket's person with `--json`, and stops naming the command with nobody to
  ask. The Feishu production-app creation moves from `deploy` into `channels setup`.

## 3. Who performs each operation

Three parties: the **instance** (the serving process, on the box), the **person** (at a machine running the CLI, or a
platform's web page), and **CI**. No FastAgent flow holds a developer credential.

| Platform | Operation | Needs | Performed by |
|---|---|---|---|
| Telegram | Create the bot | BotFather | Person, once; pastes the bot token into setup |
| | Receive, send, `setWebhook` | Bot token, secret token (setup generates it) | **Instance**, on every start (§5) |
| Feishu | Create the app | Scan-to-create (device authorization); nothing is kept | Person, once |
| | Receive, send; set the Request URL (v7 PATCH); check scopes | **App ID and App Secret**, the app's own | **Instance**, on every start |
| | Capture the Verification Token | No read API; only the `url_verification` challenge | Setup, through a throwaway tunnel, only when the store has none |
| | Tenant approval, version publish | The console only | Person, once (the instance warns of a missing scope) |
| Lark | Create the app | Guided console, credentials pasted | Person, once |
| | Set the Request URL | The configuration API, which often answers 404 | Instance; on 404, the person on the app page, once (§5) |
| Slack | Create and install the app | The manifest link (`https://api.slack.com/apps?new_app=1&manifest_json=…`) and a person's Allow | Person, once; pastes the bot token and signing secret into setup |
| | Receive, send | Bot token, signing secret | Instance |
| | Set the Request URL | The app's Event Subscriptions page, which verifies it on saving | Person, once per URL (§5) |
| | New scopes or events | The app's manifest page, then reinstall | Person; setup prints the manifest and the page |

The Feishu Verification Token is captured at setup and not by the instance registering itself: the instance's URL is
public and stable, so accepting the first challenge's token there would let anyone who posts a forged challenge first
plant theirs; the throwaway tunnel's URL is random and lives for one capture. Capturing re-points the app's Request
URL at the tunnel, so setup leaves it there only until the instance's next start, which sets it (§5); setup sets it
back at once only when an instance is already serving at `http.publicUrl`, since the platform verifies a URL as it is
set.

Slack's App Configuration token, which would let FastAgent create apps and set their Request URL through the
manifest API, is not used: it is a person's credential that expires every 12 hours and rotates its refresh token on
each use, held for a step that happens once per URL. Slack's own self-hosted deployment guides (Heroku, AWS Lambda)
have the person paste the URL into Event Subscriptions after deploying. An opt-in that brings one is left for later
(§9).

## 4. Where each record lives

| Data | Nature | Lives in |
|---|---|---|
| Which app, and the URL a person set there and the platform verified: `channels.<name>.app: { id, team?, url? }` | The instance's binding; not secret; must survive a state reset; shared by everyone who operates the instance | **Instance configuration**, delivered with `--config` (as Slack CLI's `apps.json`). For a channel whose URL only a person sets: Slack, and Lark without its configuration API |
| Slack signing secret and bot token; Feishu and Lark App ID, App Secret, Verification Token, Encrypt Key; Telegram bot and secret tokens | Runtime credentials | **The instance's store** (agent-artifact.md §6.2) |
| That a platform reached this instance with a signed request, and at which URL | Evidence the serving process observes | **The instance's state** (`<state root>/channels/<name>/`) |

Nothing is kept on the person's machine, and nothing in the state root but what the serving process observes. The
Slack onboarding record (`<state root>/channels/slack/onboarding.json`, configuration tokens and all) goes.

The project's root `fastagent.json` is the **development instance's** configuration, and a development app is one
person's (two developers on one dev app take each other's messages). So it is personal: the scaffold's `.gitignore`
lists it, as Slack CLI keeps `apps.dev.json` out of git, and what a team shares goes in the program's `defaults` or a
shared deployment configuration (`prod.json`). `content add`'s directory entries, which are machine paths, already
made it one.

## 5. Keeping the platform pointed at the instance

**Where the platform lets the app's own credentials set it (Telegram, Feishu, Lark with its configuration API), the
instance sets it on every start.** Once the serve is ready, the serving process points each webhook channel at its
public URL, without reading it first: Telegram's `getWebhookInfo` does not return the `secret_token`, so a rotated
secret behind an unchanged URL would read as nothing to do and every update would then be refused; Feishu's v7
configuration route accepts only a PATCH. Both calls are idempotent. Frameworks do the same at startup
(python-telegram-bot's `run_webhook` sets it "anyhow"). A restart repairs a URL or secret that drifted, and
`dev --tunnel` takes the same path.

- **The public URL is an explicit input, never inferred** from the environment, because the same package runs
  embedded under a prefix (`https://x.fly.dev/agent`) and on laptops holding production credentials, where a guessed
  URL would point the bot at the wrong place:
  - `http.publicUrl` in the configuration. `deploy` writes it into the configuration it delivers when it knows it
    before the build: Fly (`https://<app>.fly.dev`), Railway (`railway domain` before `railway up`, verified: it
    creates the service's domain before any deploy and answers the existing one when run again).
  - AgentCore: the forwarder, which resolves its own Function URL already, carries it in its probe envelope.
  - Docker with `--tunnel`: read from the generated cloudflared service's `/quicktunnel` metrics endpoint (verified),
    which the generated Compose names to the agent.
  - None: nothing is registered, and the outcome says so with the URL to use.
- **The library makes it a step of its own** (SPEC §8): `service.listen()` registers in the background once the serve
  is ready when `http.publicUrl` is set; an app that mounts `service.fetch` calls `service.registerWebhooks()` once
  it is ready. `Service.webhooks` and `/health` report each channel's outcome, `pending` until it ends; `deploy` reads
  `/health` and applies the registration gate it applies today, which fails only on `failed`.

**Where only a person can set it (Slack; Lark when its configuration API answers 404), the person pastes it once and
the instance confirms it.**

- The outcome is `manual`, its step the full URL and the page: `paste https://x.fly.dev/slack into Request URL at
  https://api.slack.com/apps/A0123/event-subscriptions, then Save Changes`. At a terminal `deploy` opens the page;
  with `--json` the step is the ticket's `afterwards`.
- Saving makes the platform verify the URL (Slack's signed `url_verification`; Lark's token-bearing challenge), which
  the channel answers. An authenticated request **addressed to that URL**, the verification or any event, is the
  evidence: the channel records it in its state, and the outcome becomes `registered`, with no developer
  credential. A signature or token proves who sent a request, not where it was sent (Slack signs
  `v0:timestamp:body`), so the address comes from the request's host and forwarding headers; one addressed elsewhere
  (an old domain still routed here) proves nothing and is warned of, and one with no known address counts as none.
  AgentCore's forwarder passes the original host along (2b).
- At a terminal, `deploy` waits for that outcome, then writes the verified URL into the binding
  (`channels.<name>.app.url`) in the configuration `--config` names. Every later deploy, CI included, delivers it, and
  an instance whose `http.publicUrl` gives the same URL reports `registered` from the start: across AgentCore's
  state reset on every deploy, and across Lark's 404 on every start. A different URL is `manual` again, truthfully.
  The record is of the moment it was verified: a person who later changes the platform's page changes it too.
- Where the URL is known before the app is created (Fly, Railway), setup puts it in the Slack manifest link, so the
  page holds it already and the person clicks Retry once the instance serves, instead of pasting. *To verify:*
  whether Slack creates an app whose Request URL has not answered yet.
- The instance checks at start the scopes it holds (Slack's `x-oauth-scopes` header on any call; Feishu's scope
  list) and warns of a missing one, so a changed channel that needs a reinstall is said where it shows.

**Development needs no public URL.** Every platform recommends a connection the app opens for development (§6), so
`dev` receives each first-party channel that way: Feishu's and Lark's long connection (implemented), Slack's Socket
Mode and Telegram's long polling (§10). Their scaffolds offer both ways with `byIngress`. `dev --tunnel` remains for
trying the webhook path locally.

- Slack's Socket Mode needs an app-level token (`xapp-`, scope `connections:write`), generated on the app's page and
  pasted at setup. *To verify:* whether `apps.manifest.create` returns one for a Socket Mode manifest; it lists a
  `failed_generating_app_token` error, and its documented response carries none.
- Telegram's long polling deletes any webhook first, since `getUpdates` does not work while one is set; the dev bot
  is the dev instance's, apart from production's.

## 6. Every channel, every host

| Channel | Once, by a person | Every deploy, CI included |
|---|---|---|
| Telegram | Create the bot, paste its token | Nothing: the instance sets the webhook |
| Feishu | Scan to create; approve and publish where the tenant reviews scopes | Nothing: the instance sets the Request URL |
| Lark | Create in the console, paste the credentials; on a 404, paste the URL on the app page after the first deploy | Nothing: the API sets it, or the recorded URL says it is set |
| Slack | Create from the manifest link and install, paste the credentials; paste the URL on the app page after the first deploy | Nothing while the URL is unchanged: the recorded URL says it is set |

| Host | Way of receiving by default | Public URL |
|---|---|---|
| `dev` | `connection` | None needed; `--tunnel` for the webhook path |
| Docker, `--tunnel` (to try, or to reproduce a deployment) | `webhook` | The Quick Tunnel's, new on every start |
| Docker, own ingress | `webhook`, or `connection` set in the configuration | `http.publicUrl` |
| Fly, Railway | `webhook` | Written by `deploy` |
| AgentCore | `webhook` only | The forwarder's |
| A package on someone's server (`npx @acme/x start`) | `webhook`, or `connection` | `http.publicUrl`, the operator's |
| An embedding app | The app's choice | `registerWebhooks(baseUrl)` |

## 7. What the platforms recommend

Each platform recommends a connection the app opens for development and webhooks for a deployment, which is the
default `byIngress` takes (`dev`: `connection`; everything else: `webhook`):

- **Slack**: Socket Mode while developing; HTTP Request URLs once deployed, for reliability (Socket Mode's backend
  recycles connections) and required by the Slack Marketplace; on Lambda, acknowledge only after the work is safe
  (`processBeforeResponse`).
- **Feishu and Lark**: the long connection for self-built apps, deployable too; "if you deploy in a FaaS model,
  send events to the developer's server". Store apps receive by webhook only.
- **Telegram**: long polling on a machine that runs all the time; webhooks are required on serverless hosts.

Runtime credentials live in the host's environment in each platform's own deployment guides.

## 8. Borrowed from Slack CLI, not depended on

Slack CLI (v3, Bolt apps) keeps one app per project and environment (`.slack/apps.dev.json` personal,
`.slack/apps.json` shared), links an existing app (`slack app link`), and creates and installs the local app on the
first `slack run`. FastAgent takes those ideas per **instance** rather than per project. It does not take the
manifest sync, which needs the configuration token (§3), and it does not depend on the CLI: a separate Go binary
installed outside npm, with records in a project directory that an npm-installed agent does not have, which starts the
app itself through hooks.

## 9. Known risks and later

- On a host that scales to zero, a process must not be frozen between acknowledging an event and finishing the turn.
  AgentCore keeps a busy session (`HealthyBusy`); Fly Sprites and Railway Serverless must be checked before FastAgent
  supports them.
- Later: an opt-in Slack configuration token, for those who want the Request URL and manifest set without a person;
  the OS keychain for every credential FastAgent keeps, decided with where credentials live.

## 10. Delivery

1. The SPEC: `http.publicUrl`, `Service.registerWebhooks()`, `Service.webhooks` and `/health` (#932);
   `channels.<name>.app` as the binding with its verified `url`.
2. The instance registering itself: `http.publicUrl`, `registerWebhooks()`, `/health`, `start`, and `deploy` reading
   the outcome, with Fly and Railway writing the URL (2a); AgentCore's forwarder carrying it (2b); Docker's tunnel
   (2c). The signed-request evidence and the recorded URL for Slack and Lark.
3. `connection` for Slack (Socket Mode) and Telegram (long polling), so `dev` needs no tunnel; in parallel with 2.
4. `channels setup`, `add` changing only the program, `dev` setting up on first run; Feishu production-app creation
   out of `deploy`; the Slack onboarding record removed; `fastagent.json` in the scaffold's `.gitignore`.
