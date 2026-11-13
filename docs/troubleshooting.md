---
title: Troubleshooting
description: "Fixes for common FastAgent setup and runtime issues: missing model, login and auth, ports, webhooks, sessions, schedules, and deployment."
status: current
---

# Troubleshooting

Find the message or symptom, then the fix. `fastagent info --json` reports everything the agent loads, for bug reports
and CI.

## Setup

### `missing model`

The run has no terminal to ask, and no model is set. Set one:

```bash
fastagent dev --model provider/modelId          # this run
FASTAGENT_MODEL=provider/modelId fastagent dev   # this shell
# or defaults.model in fastagent.config.ts       # always
```

`fastagent models` lists the specs. A **deployment** reads only the config: set `defaults.model` (or `model` in the
file `--config` names) and deploy again.

### `auth: (none found)`

The provider has no credential here. You probably ran `fastagent login` in another agent: credentials are per agent
(`.secrets/auth.json`), plus `~/.fastagent` for `login -g`. Run `fastagent login` in this agent, or set the provider's
key (`OPENAI_API_KEY`, …) in `.secrets/.env`.

### A module does not load

`Cannot find package`, `Unexpected token 'export'`, or a refusal naming a file in `src/`. Check:
- `npm install` ran, and `package.json` has `"type": "module"` and the packages the code imports;
- the file sits directly in `src/tools/`, `src/extensions/`, `src/channels/` or `src/schedules/` and default-exports
  what that directory holds; helpers live outside them.

### `Invalid schema for function '…'`

OpenAI accepts only some string formats (`date-time`, `date`, `email`, `uuid`, …), so `str({ format: "uri" })` breaks
the tool. Use a pattern: `str({ pattern: "^https?://\\S+$" })`.

### Port already in use

`--port 8788`, or `PORT` for `start`.

### `the storage … is held by another process`

Another `dev`, `start` or `schedules run` of this agent is running. Stop it. (`invoke` uses its own storage and can run
beside them.)

## Local development

### `dev` does not pick up a change

Prompt, `AGENTS.md`, skill and template edits apply on the next message. Code (`src/`, config, `package.json`,
`.secrets/.env`) restarts the worker once running messages finish. Anything else, such as `lib/`, needs a manual
restart. After a broken edit, fix it and save again.

### Webhooks do not arrive locally

You need `fastagent dev --tunnel` (with `cloudflared`) and the channel set to `webhook`. A new tunnel has a new URL:
restart it to re-register, or use your own stable URL as `http.publicUrl`. Check the path (`/telegram`, `/slack`,
`/feishu`, `/lark`) and that the platform's secret matches `.secrets/.env`.

### A schedule did not fire

Only a running `dev` or `start` fires schedules (`invoke` does not). A run missed while down is caught up once. A host
that scaled to zero sleeps through it ([scale to zero](deploy.md#scale-to-zero)). `fastagent schedules list` shows the
next and last runs.

### `busy`

The session's queue is full, or the request said `whenBusy: "reject"`. Use separate sessions for separate work.

### Proxy or network errors

Set `HTTPS_PROXY` (in the shell or `.secrets/.env`). Loopback is never proxied; add a LAN address you bind to
`NO_PROXY` yourself.

## Channels

### Telegram

- **Webhook returns 401:** `TELEGRAM_SECRET_TOKEN` does not match what was registered. Restart the serve so it
  registers again.
- **Polling ends with "another process polls this bot":** another process polls or a deployment receives for this
  bot. Stop it, or use a separate dev bot.
- **No reply:** check the token, that the bot may post in the chat, that the message summons it (private, mention or
  reply), and the log.
- **Group messages ignored:** turn privacy mode off and re-add the bot ([Telegram](telegram.md#set-it-up)).

### Slack

- **401:** `SLACK_SIGNING_SECRET` does not match the app's, or a proxy rewrote the body.
- **No events:** reinstall after scope changes, invite the app to the channel, and check its event subscriptions and
  Request URL (`https://…/slack`). Click **Retry** in Event Subscriptions once the instance is up.

### Slack Socket Mode is connected but nothing answers

Slack accepts a connection even when Socket Mode is off for the app, and then sends nothing. Open the app named in the
log (`Socket Mode connected to app A…`) → **Socket Mode** → **Enable**. A warning about other open connections means
another process uses the same app and takes some messages: give each instance its own app.

### Feishu / Lark

- **URL verification fails:** the service must be running at the saved URL with the right path, and the Verification
  Token and Encrypt Key must match the console (set both or neither).
- **Group messages ignored:** the app lacks `im:message.group_msg`. Run `fastagent channels setup feishu` to see
  missing scopes, approve them, and publish a new version.

### Files and images

- **Images ignored:** the model must support vision.
- **A file is not found:** downloads live under `<state root>/channels/<name>/files/` and are never deleted, so the
  state root moved or its volume is not mounted.
- **Slack files fail:** the app needs `files:read`; Slack Connect, deleted files and files over 20 MB cannot be read.

## Deployment

### Sessions disappear after a redeploy

The state root is not on persistent storage. Generated deployments handle this; on your own server set
`FASTAGENT_ROOT=/data FASTAGENT_SECRETS_DIR=/data/.secrets`. On AgentCore every deploy resets it.

### A deploy stopped and the message does not say why

The host CLI's output is printed above the error line. The same inputs fail the same way, so read it first.

- **Fly: `authentication handshake failed` or `connecting to Depot builder: timed out`:** a VPN or a proxy's TUN mode
  blocks Fly's builder. Turn it off for the deploy, or run the printed runbook with `fly deploy --depot=false`.
- **Fly: `FASTAGENT_SECRETS_DIR may be a potentially sensitive environment variable`:** it is a path. Ignore it.
- **`no provider of the deployed agent offers "…"`:** the model name is wrong; the message lists close ones.
- **`auth_required` from `invoke --url`:** the deployment has no credential for its model:
  `fastagent secrets set <host> <KEY>` or `fastagent login <provider> --deployment <host>`.
