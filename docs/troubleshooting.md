---
title: Troubleshooting
description: "Fixes for common FastAgent setup and runtime issues: missing model, login and auth, ports, webhooks, sessions, schedules, and deployment."
status: current
---

# Troubleshooting

Common FastAgent setup and runtime issues.

## `missing model`

FastAgent needs a model spec such as `openai/gpt-5.5`. In a terminal, `dev` / `start` /
`invoke` prompt you to pick one from the full catalog (logging you in inline when the pick needs
auth) and use it for the run, printing the line to put in the config. This error means the run is **non-interactive** (CI, a container, a piped
command, a coding agent) with no model set; it exits 2, as any choice a terminal would have asked for.

Check available specs:

```bash
fastagent models
```

Set one with any of:

```bash
fastagent dev --model provider/modelId
FASTAGENT_MODEL=provider/modelId fastagent dev
# or fastagent.config.ts: { defaults: { model: "provider/modelId" } }
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
  `@earendil-works/pi-ai`, `@earendil-works/pi-schema`, its own) are in its `package.json`,
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
at all. `str({ format: "uri" })` emits it: use a pattern instead, which every provider accepts, and validate
further in `execute` if needed:

```ts
parameters: obj({ url: str({ pattern: "^https?://\\S+$" }) }),
```

## Port already in use

Use another port:

```bash
fastagent dev --port 8788
fastagent build && fastagent start --port 8788
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
lives under the instance's
`.state/` (by default in the project's `.fastagent/dev/`, and `.fastagent/start/` for `start`), the credentials (`auth.json`, rotated by each OAuth refresh) under its `.secrets/`, and the clones of its
github content under its `content/`:

```txt
<state root>    # default <agent dir>/.fastagent/dev/.state (start: .fastagent/start/.state)
<secrets dir>   # default <agent dir>/.secrets
content/        # <working directory>/content (default <agent dir>/.fastagent/dev/content)
```

A redeploy that replaces the agent wipes all three. Point each at durable storage (generated deployments do):

```bash
fastagent build   # `start` opens dist/
FASTAGENT_ROOT=/data FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
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

One process holds an agent's storage (`<state root>/agent.sqlite`) at a time: another `dev`, `start`, `schedules run`
or `schedules unwake` of the same agent is running, or another agent shares its state root (`FASTAGENT_STATE_DIR`).
Stop that one first. `fastagent invoke` uses storage of its own (`<state root>/invoke.sqlite`) and runs beside them;
one `invoke` of an agent runs at a time.

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

## Telegram polling ends with "another process polls this bot"

Telegram lets one process poll a bot. Another `fastagent dev`, a deployment that polls, or a script calling `getUpdates`
holds it: stop that one, or give this instance its own bot (a dev bot apart from production's). A bot that receives by
webhook cannot be polled either, and polling deletes its webhook at start; if a deployment points the bot at its URL
while a poll runs, the poll ends with "a webhook was set for this bot while it polls".

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

Slack's Request URL is the app's own page, which no credential FastAgent holds can change: `dev --tunnel` and
`deploy --run` print the URL to set under Event Subscriptions, and Slack verifies it as you save. Click **Retry** there
once the instance is serving if the URL was set first. A development instance that receives by Socket Mode has no
Request URL at all.

## Slack Socket Mode is connected but nothing answers

`long connection ready: slack socket mode` means Slack accepted the app-level token and said hello; it does **not** mean
events will arrive. Slack answers the connection the same way whether or not Socket Mode is on for the app, and sends
events only while it is on (with it off, they go to the app's Request URL, which a Socket Mode app does not have). It
says so only to a connection that was already open when the switch was turned off (`link_disabled`, which ends the
serve), so a process started afterwards is connected and deaf. The first line of the connection names the app
(`Socket Mode connected to app A…`): open that app → **Socket Mode** → **Enable Socket Mode**, and check it is the app
whose tokens are in `.secrets/.env`.

The same line is followed by a warning when other connections are already open for the app: Slack hands each event to
one of them at random, so a second process with the same app-level token (another `dev`, a colleague's) takes some of
the messages. Give each instance its own app, or stop the other.

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

`fastagent channels setup feishu` keeps these values in the instance's value file; re-check them after rotating
keys in the developer console.

## Feishu bot ignores group messages

With only the `im:message.group_at_msg:readonly` scope, the platform delivers just the messages that
@mention the bot. Unmentioned group or thread discussion never reaches the channel, so it cannot be
buffered, and bare continuations inside Agent-created threads are not delivered either.

Re-run `fastagent channels setup feishu` (or `lark`). It checks the app's permissions, names every scope that is
missing, and links the console page that requests them; approve them (a tenant admin, if your tenant
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

`deploy` reads the model from `FASTAGENT_MODEL` in `.secrets/production/.env`, else `defaults.model` in `fastagent.config.ts`. A
`FASTAGENT_MODEL` exported in your shell is not read, and `deploy` has no `--model` flag. Set one of the two and
redeploy; `deploy` prints the effective model and its source. To switch models, change it here and redeploy. See
[Deploy](deploy.md).

## Webhooks stop working after a tunnel restart

Quick Tunnel URLs are ephemeral. Restarting `fastagent dev --tunnel` (or `start --tunnel`) mints a new URL, and the old webhook registration points at a dead one.
Re-run `fastagent dev --tunnel` to register the new URL. For a stable endpoint, bring your own named tunnel
or reverse proxy and name its URL as `http.publicUrl`.

## Proxy / network issues

FastAgent CLI commands install proxy-aware fetch handling. Set standard proxy env vars before running commands:

```bash
HTTPS_PROXY=http://127.0.0.1:7890
```

Then retry. The variables can also live in the agent's `.secrets/.env`; every command reads it before making
requests.

Loopback (`localhost`, `127.0.0.1`, `::1`) is always added to `NO_PROXY`. A LAN address is not: after
`fastagent dev --bind 192.168.1.5`, add that address to `NO_PROXY` yourself.

## A deploy stopped and the message does not say why

A `deploy --run` that fails prints the host CLI's own output above its last line, and the ticket of `deploy <host> --run
--json` carries the last lines of that output as `log_tail` (the whole log is at `log`). Read it for the cause before
running the deploy again: the same inputs fail the same way.

- **Fly: `failed to list workers … authentication handshake failed`, or `connecting to Depot builder: timed out`.** flyctl
  cannot reach its remote builder. Measured on one machine: with a proxy tool's TUN mode (all traffic through a tunnel
  interface) on, three deploys failed this way and `fly doctor` found no fault, and with TUN off the same build took
  15 to 25 seconds, with or without `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` set. Unsetting the variables does not leave a
  tunnel, so turn the TUN or VPN off for the deploy. Where that is not possible, follow the runbook `fastagent deploy fly`
  prints (without `--run`) and add `--depot=false` to its `fly deploy` line, which builds on Fly's own builder, then set
  the Agent API key with `fastagent secrets set fly FASTAGENT_API_KEY --generate` and log the box in as the runbook says.
- **Fly: `WARN FASTAGENT_SECRETS_DIR may be a potentially sensitive environment variable`.** It is a path, not a
  secret. Ignore it.
- **`no provider of the deployed agent offers "…"`.** The model name is not one a provider lists. The message names the
  closest models; `fastagent models <provider>` lists them all.
- **`auth_required: Provider is not configured` from `invoke --url`.** The deployment has no credential for its model:
  `fastagent secrets set <host> <the provider's API key variable>`, or `fastagent login <provider> --deployment <host>`.

## Need a machine-readable report

Use:

```bash
fastagent info --json
```

This is useful in CI and bug reports.
