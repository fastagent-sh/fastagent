---
title: Channels across environments
description: "A deployment receives Feishu/Lark by webhook by default and the laptop keeps WebSocket; until per-environment apps exist, one app serves one environment at a time, and the switch is said where it happens."
type: design-doc
status: implemented
updated: 2026-10-08
---

# Channels across environments

**Status: implemented.** It answers #749 for what can be done with one set of credentials, and leaves per-environment
apps (staging, production, a laptop beside them) to the multi-environment work.

## 1. The problem

A chat channel is bound to a platform app: a Telegram bot, a Slack app, a Feishu/Lark app. An agent has one app per
channel and one value file (`.secrets/.env`), which is both the laptop's environment and what `deploy --run`
carries.

| | Telegram | Slack | Feishu / Lark |
|---|---|---|---|
| Ingress | webhook only | webhook only (Events API) | WebSocket (default since #748) or webhook, written into `channels/<kind>.ts` |
| What one app can point at | one webhook URL | one Request URL | one subscription mode, and in webhook mode one Request URL |
| Who points it at a deployment | `deploy --run`, with the bot token | `deploy --run`, with the App Configuration token held by the machine that ran `add slack` | `deploy --run`, with the app credentials and `application:application:patch` (Lark: often by hand) |

Feishu adds a problem of its own: the ingress is fixed in the channel file, and the default is WebSocket. A
default Feishu agent therefore cannot scale to zero (a connection cannot wake a stopped machine) and cannot deploy
to AgentCore at all, until the author edits the file and switches the app's subscription mode, which also needs the
reviewed `patch` scope.

## 2. Decisions

1. **A deployment receives Feishu/Lark by webhook by default**, on every deploy host: Docker, Fly, Railway and
   AgentCore. Docker counts: it exists to deploy. `dev` keeps WebSocket by default, which needs no public URL and no
   `patch` scope. This holds whether or not the agent must stay up anyway (a schedule): one rule, and an agent
   that later drops its schedule can scale to zero without a change. WebSocket stays available to a deployment that
   names it, and then pins one machine up as today; AgentCore takes webhook only.
2. **One set of credentials.** The agent keeps one value file and one app per channel. Per-environment apps and
   values are the multi-environment work, deferred: they add a second app and a second file to every author's setup,
   and most agents have one deployment.
3. **Lark's manual step is accepted.** Its config API often answers 404, so a deployment's Request URL is set once in
   the console. A deployment's URL is stable, so once is enough.
4. **No migration.** An agent deployed with WebSocket keeps working until its next deploy follows the new defaults.

## 3. One app serves one environment at a time

This follows from decision 2, for every channel, and is already true of Telegram and Slack today: whichever process
last pointed the app at itself receives its messages.

- **Deploying moves the app to the deployment.** For Feishu/Lark it also switches the app to webhook mode, after which
  a laptop's WebSocket receives nothing.
- **`dev` after a deploy** on Feishu (WebSocket) connects but receives nothing, because the app is in webhook mode.
  On every channel, `dev --tunnel` points the app at the laptop, and the deployment receives nothing until the next
  `deploy --run` points it back.

The cost is accepted until per-environment apps exist. What is not accepted is a silent switch, so the command that
moves an app says so where it happens (§4.4).

## 4. Proposal

### 4.1 The ingress is a setting, and the command supplies its default

`add feishu|lark` writes one channel file whose ingress is a setting, not a choice of factory:

- `FEISHU_INGRESS` (`LARK_INGRESS`) = `webhook` | `websocket`, read from the environment.
- **Unset means `webhook`.** That is the channel's own default, and what `start` serves: every deploy host runs
  `start`, so a deployment receives by webhook with nothing set, and `deploy` injects nothing.
- **`dev` supplies `websocket` when it is unset**, with or without `--tunnel`. `dev` marks its process
  (`FASTAGENT_DEV=1`, inherited by its worker) before any channel file is imported, and the channel's rule reads
  the mark. The mark lives in the environment because the channel imports the agent's own installed copy of
  fastagent, which shares nothing else with the CLI's; `FEISHU_INGRESS` itself is never rewritten. Testing webhook
  on a laptop means naming it.
- A value in `.secrets/.env` wins for both commands. Since the file is shared, `FEISHU_INGRESS=websocket` there keeps
  WebSocket on the deployment and on the laptop alike; that is how an author opts a deployment out of webhook.
- The webhook credentials (`FEISHU_VERIFICATION_TOKEN`, optional `FEISHU_ENCRYPT_KEY`) are required only when the
  ingress is `webhook`, and the channel names the one that is missing.
- `start` on a laptop follows the deployment's default: it is the serving command a host runs, so it needs a public
  URL for Feishu/Lark, or `FEISHU_INGRESS=websocket`.
- The channel file picks its factory at import (`feishuIngress()`), so the module's shape carries the answer, and
  every reader that already read the shape (the secrets gate, `deploy`'s preflight, residency, registration) needs
  no change. A webhook module declares the Verification Token; a WebSocket one does not.
- `add feishu|lark --ingress webhook|websocket` writes the setting for both commands; with `webhook` it also
  prepares the app at once (§4.2). Without the flag `add` writes nothing.

*Rejected: `deploy` setting the value on the box.* Then the default lives in a second place, and a box started
any other way (a hand-written Dockerfile, `fastagent start` on a server) would fall back to WebSocket. The command
that serves is the one place that knows whether it is serving a laptop.

*Rejected: inferring the ingress from which credentials are present* (a verification token means webhook). It is the
same decision made invisibly: once `deploy` writes the token into the shared file, the laptop would switch to
webhook too, without anyone choosing.

### 4.2 `deploy` prepares the app for webhook

When the deployment's ingress is webhook (the value file does not name `websocket`) and the value file has no
Verification Token, `deploy --run` prepares the app before it builds anything (`prepareWebhookApps`), with the
machinery `add feishu` already has:

1. **`patch` scope.** `checkAgentScopes` with the webhook scopes: if `application:application:patch` is missing, it
   opens the console page that requests it; the token then cannot be captured, and the deploy's gate on declared
   values stops the run until it is granted and a version published. In a
   tenant that reviews `patch`, the admin approves here, once, at a deliberate moment, and no longer at the first
   `add feishu`.
2. **Verification Token.** Captured as `add feishu --ingress webhook` does today (a temporary tunnel answers the
   console's challenge), and written to `.secrets/.env`.
3. **Request URL.** Registered at the deployment's URL after it answers `/health`, as today.

Lark follows its guided console flow and sets the Request URL by hand (decision 3). Telegram and Slack need no
preparation: they are webhook already.

### 4.3 Docker

A webhook needs a public URL. `deploy docker --tunnel` provides one that changes when the tunnel restarts (re-run
`--run` to point the app again); a stable one is the operator's own ingress. Without either, `deploy docker` says the
Feishu/Lark channel cannot receive and names both options.

### 4.4 Moving an app is said where it happens

- `deploy --run` ends by saying the app now points at the deployment, and that `dev` on this machine will not receive
  that channel's messages (Feishu/Lark: the app is in webhook mode; `dev --tunnel` would take it back).
- `dev --tunnel`, before it points an app at the laptop, says it is taking that channel's messages from wherever the
  app pointed, and that `deploy --run` points it back.
- Preparing a Feishu/Lark app for webhook says the app is in webhook mode now, so `dev` on this machine receives
  nothing from it.

## 5. What changes for the author

| Today | After |
|---|---|
| A default Feishu agent cannot scale to zero or reach AgentCore without editing its channel | the deployment receives by webhook with no edit |
| Switching to webhook means editing the channel file and the console by hand | `deploy` prepares the app: the `patch` scope, the Verification Token, the Request URL |
| The `patch` review can hold the first `add feishu` | `add feishu` asks for no `patch`; the review happens once, when the agent is first deployed |
| `dev --tunnel` after a deploy silently takes the deployment's messages | it still takes them, and says so |

## 6. Deferred: per-environment apps

A laptop and a deployment working at the same time, or staging beside production, needs one app per environment
and a value file per environment, created and selected by `dev` and `deploy`. Its questions are recorded for that
work:

- One value file per deployment, or one overlay on the shared file?
- Who creates the second app: `deploy`, through each platform's creation flow (Telegram cannot: BotFather only)?
- Slack's onboarding state holds one app, and its App Configuration token lives on one machine; teammates and CI
  need both (#762).
