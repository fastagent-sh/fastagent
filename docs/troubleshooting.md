---
title: Troubleshooting
description: "Fixes for common FastAgent setup and runtime issues: missing model, login and auth, ports, webhooks, sessions, schedules, and deployment."
status: current
---

# Troubleshooting

Common FastAgent setup and runtime issues.

## `missing model`

FastAgent needs a model spec such as `openai-codex/gpt-5.5`. In a terminal, `dev` / `start` /
`invoke` prompt you to pick one from the full catalog (logging you in inline when the pick needs
auth) and use it for the run, printing the line to put in the config. This error means the run is **non-interactive** (CI, a container, a piped
command) with no model set.

Check available specs:

```bash
fastagent models
```

Set one with any of:

```bash
fastagent dev --model provider/modelId
FASTAGENT_MODEL=provider/modelId fastagent dev
# or fastagent.config.ts: { model: "provider/modelId" }
```

Precedence:

```txt
--model > FASTAGENT_MODEL > fastagent.config.ts model
```

## `auth: (none found)`

The selected provider has no credentials.

Most common cause: you ran `fastagent login` in a different agent. Login writes `<agent dir>/.secrets/auth.json`;
an agent also reads `~/.fastagent/.secrets/auth.json` (written by `fastagent login -g`) for a provider it has no
other credential for (its own `auth.json`, a provider in its config that authenticates itself, an env variable), but
not another project's file. An explicit `FASTAGENT_AUTH_PATH` or `FASTAGENT_SECRETS_DIR` disables that
fallback.

Options:

```bash
cd <agent dir> && fastagent login
```

or set a provider API key in `.env` / environment, for example:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

Behind a proxy, set `HTTPS_PROXY` before running login or serving.

## A module does not load

Symptoms include `Cannot find package`, `Cannot use import statement outside a module`, `Unexpected token 'export'`,
or a refusal naming a file of `src/`.

Check:

- the agent ran `npm install`, and the packages its code imports (`@earendil-works/pi-durable`,
  `@earendil-works/pi-ai`, its own) are in its `package.json`,
- `package.json` has `"type": "module"`,
- the module sits directly in `src/tools/`, `src/extensions/`, `src/channels/` or `src/schedules/`, ends in `.ts`,
  `.mts`, `.js` or `.mjs`, and is not a test (`*.test.*`, `*.spec.*`); a helper it imports lives outside those
  directories,
- it default-exports what its directory holds (a tool: pi-durable's `defineTool`; a schedule: `defineSchedule`), or
  `needs([...])` around it,
- `fastagent info` lists it with its file; it refuses, naming the file, when one does not load.

Then send the agent a message that uses it:

```bash
fastagent invoke "Use the <name> tool on …"
```

## `Invalid schema for function '…'`

```text
Codex error: Invalid schema for function 'fetch-url': In context=('properties', 'url'), 'uri' is not a valid format.
```

OpenAI's strict tool schemas accept only these string formats: `date-time`, `time`, `date`, `duration`, `email`,
`hostname`, `ipv4`, `ipv6`, `uuid`. Any other one fails every message on that provider, so the tool cannot be called
at all. `Type.String({ format: "uri" })` emits it: use a pattern instead, which every provider accepts, and validate
further in `execute` if needed:

```ts
parameters: Type.Object({ url: Type.String({ pattern: "^https?://\\S+$" }) }),
```

## Port already in use

Use another port:

```bash
fastagent dev --port 8788
fastagent start --port 8788
```

For `start`, hosted environments can set `PORT`.

## Dev does not pick up changes

`fastagent dev` separates two change classes:

- **`SYSTEM.md`, `AGENTS.md`, skills and prompt templates** are read for every message.
- **Code inputs** (`src/`, `fastagent.config.ts`, `package.json`, `.secrets/.env`) restart the dev worker once the
  messages running in it finish (at most 10 minutes).

Nothing else is watched, including files the agent writes and helper code imported from outside `src/`; restart
manually for those.

If the worker stopped after a broken code edit, save another change after fixing the error. The supervisor should retry.

Use `--no-watch` to serve once without the supervisor.

## Sessions disappear after redeploy

By default, machine state (the agent's storage, `agent.sqlite`, with its sessions; channel state; schedule state)
lives under the agent's
`.state/`, the credentials (`auth.json`, rotated by each OAuth refresh) under its `.secrets/`, and the clones of its
github content under its `content/`:

```txt
<state root>    # default <agent dir>/.state
<secrets dir>   # default <agent dir>/.secrets
content/        # <agent dir>/content
```

A redeploy that replaces the agent wipes all three. Point each at durable storage (generated deployments do):

```bash
ln -sfn /data/content content   # in the agent directory, before every start: a redeploy replaces the directory
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

The storage lives under the state root. Set `FASTAGENT_SECRETS_DIR` too, or a rotated `auth.json` stays in the agent
dir.

## `busy`

A message for a busy session queues behind the ones before it by
default (`whenBusy: "queue"`), so `busy` means one of two things: the request asked not to wait (`whenBusy: "reject"`,
which is how a schedule's occurrence is skipped while its previous one goes on), or the session's queue is full
(`details.reason` says which).

Fixes depend on the caller:

- use distinct sessions for independent work,
- send each message with an `idempotencyKey`, so a resend returns the message it already sent,
- design tools to be idempotent if events can overlap.

## `the storage … is held by another process`

One process holds an agent's storage (`<state root>/agent.sqlite`) at a time: another `dev` or `start` of the same agent
is running, or another agent shares its state root (`FASTAGENT_STATE_DIR`). Stop that one first. `fastagent invoke`
uses storage of its own and runs beside them.

## A channel or schedule is disabled

To keep a module without mounting it, rename it so it no longer ends in `.ts`, `.mts`, `.js` or `.mjs`:

```bash
mv src/channels/telegram.ts src/channels/telegram.ts.disabled
```

## Webhook not receiving events locally

For local webhook development:

```bash
fastagent dev --tunnel
```

Check:

- `cloudflared` is installed,
- the public URL printed by FastAgent is the one configured in the provider,
- the route path matches the channel (`/telegram` for Telegram, `/slack` for Slack, `/feishu` for Feishu, `/lark` for Lark),
- the provider secret matches your `.env`,
- your `.env` is loaded from the agent's `.secrets/` directory.

## Telegram webhook returns 401

The `x-telegram-bot-api-secret-token` header must match `TELEGRAM_SECRET_TOKEN`.

If using `fastagent dev --tunnel`, rerun after changing `.env` so the webhook registration uses the new token.

## Telegram messages send no final reply

Check:

- `TELEGRAM_BOT_TOKEN` is set,
- the bot is allowed to message the chat,
- group messages match the route policy (private chat, reply to bot, or `@botname` mention by default),
- model credentials are configured,
- the operator log for a failed turn or Bot API error.

## Slack requests return 401 or no events arrive

For 401 responses, `SLACK_SIGNING_SECRET` must match **Basic Information → App Credentials → Signing
Secret**. Slack signs the exact raw body and timestamp; a proxy must not rewrite the body. Requests older
than five minutes are rejected to prevent replay.

For missing events, check that the app is installed/reinstalled after scope changes, invited to the
channel, and subscribed to `app_mention` plus `message.im`. Context mode additionally requires the
matching `message.channels` / `message.groups` / `message.mpim` subscriptions and
`channels:history` / `groups:history` / `mpim:history` scopes. The Request URL must be the currently
running `https://…/slack`; Quick Tunnel URLs are ephemeral.

For an app created by `fastagent add slack`, `dev --tunnel` and `deploy --run` update that URL through
the owner-local App Configuration refresh token in `<state root>/channels/slack/onboarding.json`. If
rotation/update fails, re-run `fastagent add slack` and choose **Replace App Configuration tokens**; this
does not replace the installed Bot Token. A scaffold created with `--no-onboard`, or a missing onboarding
state file, deliberately falls back to printing the manual Slack console URL.

## Slack file input fails

The app needs `files:read`. Slack Connect, deleted files, Canvas/remote files without downloadable bytes,
workspace policy, and the channel's 20 MB cap can still make a file unavailable. A current-message file
fails the turn visibly; files from the earlier discussion degrade individually. See [Slack channel](slack.md).

## Images are ignored or fail

Telegram and Slack images become `prompt.images`. The selected model must support vision. If it does not, choose a vision-capable model or route image messages differently.

## Files are not found by the agent

Telegram documents/audio/video and Slack files are downloaded under:

```txt
<state root>/channels/telegram/files/c-<chat>/
<state root>/channels/slack/files/c-<channel>/
```

The directory is `c-` plus the URL-encoded conversation id (`oc_x:thread/1` → `c-oc_x%3Athread%2F1`). The full
path is appended to the prompt.

FastAgent never prunes these files, so an ENOENT means the state root moved (check `FASTAGENT_STATE_DIR`, and that
the volume is mounted) or something else removed them. The directory grows with every inbound file; size and prune
it yourself.

## Feishu URL verification fails

When you save the event Request URL, Feishu sends a `url_verification` challenge that the running
channel must answer.

Check:

- `fastagent dev --tunnel` (or the deployed service) is running and reachable at the URL you saved,
- the path matches the channel route (`/feishu` for the Feishu scaffold, `/lark` for Lark),
- `FEISHU_VERIFICATION_TOKEN` (or `LARK_VERIFICATION_TOKEN`) matches the app's Verification Token,
- `FEISHU_ENCRYPT_KEY` matches the console's Encrypt Key setting: set both or neither. With an
  Encrypt Key configured, the channel refuses plaintext events entirely, so a missing or stale key
  value makes every event fail verification.

`fastagent add feishu` writes these values to `.env` automatically; re-check them after rotating
keys in the developer console.

## Feishu bot ignores group messages

With only the `im:message.group_at_msg:readonly` scope, the platform delivers just the messages that
@mention the bot. Unmentioned group or thread discussion never reaches the channel, so it cannot be
buffered, and bare continuations inside Agent-created threads are not delivered either.

Re-run `fastagent add feishu` (or `add lark`). It checks the app's permissions, names every scope that is
missing, and opens the console page that requests them; approve them (a tenant admin, if your tenant
requires it) and publish a new app version. A serving process warns
`im:message.group_msg is not granted — …` until the granted scope is visible. See the
[Feishu channel](feishu.md) guide.

## Schedule did not fire

Cron schedules fire only while a serving process is up:

- `fastagent dev` or `fastagent start` must be running at the cron instant; `invoke` does not start the
  scheduler,
- a run missed while the process was down is caught up once on the next start, not once per missed
  slot,
- a scaled-to-zero deployment sleeps through cron instants; keep one machine running, or wake it with a clock of your
  own through a channel (see [Deploy](deploy.md#scale-to-zero)).

Diagnose with `fastagent schedules list`: every schedule's next instant and how its last run ended (`--json` for the
retained history). A schedule whose cron is not valid is refused when the definition is built: `fastagent info`
names it, and `dev` and `start` refuse to start.

## Deployed agent crash-loops with `missing model`

`deploy` reads the model from `FASTAGENT_MODEL` in `.secrets/production/.env`, else `model` in `fastagent.config.ts`. A
`FASTAGENT_MODEL` exported in your shell is not read, and `deploy` has no `--model` flag. Set one of the two and
redeploy; `deploy` prints the effective model and its source. To switch models, change it here and redeploy. See
[Deploy](deploy.md).

## Webhooks stop working after a tunnel restart

Quick Tunnel URLs are ephemeral. Restarting the tunnel container, the Docker daemon, or
`fastagent dev --tunnel` mints a new URL, and the old webhook registration points at a dead one.
Re-run `fastagent dev --tunnel` (or `fastagent deploy docker --tunnel --run`) to register the new
URL. For a stable endpoint, bring your own named tunnel or reverse proxy.

## Proxy / network issues

FastAgent CLI commands install proxy-aware fetch handling. Set standard proxy env vars before running commands:

```bash
HTTPS_PROXY=http://127.0.0.1:7890
```

Then retry. The variables can also live in the agent's `.secrets/.env`; every command reads it before making
requests.

Loopback (`localhost`, `127.0.0.1`, `::1`) is always added to `NO_PROXY`. A LAN address is not: after
`fastagent dev --bind 192.168.1.5`, add that address to `NO_PROXY` yourself.

## Need a machine-readable report

Use:

```bash
fastagent info --json
```

This is useful in CI and bug reports.
