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
auth) and save it. This error means the run is **non-interactive** (CI, a container, a piped
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

Most common cause: you ran `fastagent login` **from a different directory**. Login is project-level —
it writes `<agent dir>/.secrets/auth.json`, and there is no fallback to the global file. Run it inside the
agent, or point every project at one shared file with `FASTAGENT_AUTH_PATH=~/.fastagent/.secrets/auth.json`.

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

## Tool import fails

Symptoms include `Cannot find package`, `Cannot use import statement outside a module`, or `Unexpected token 'export'`.

Check:

- the agent ran `npm install`,
- dependencies used by tools are in the agent's `package.json`,
- `package.json` has `"type": "module"`,
- the tool file default-exports `defineTool({...})`,
- the tool file is under `tools/` and ends in `.ts`, `.js`, or `.mjs`.

Run the tool directly for faster feedback:

```bash
fastagent tool <name> '{"arg":"value"}'
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

- **persona.md, AGENTS.md, `skills/`, and the TypeScript in `tools/`** are re-read on every turn — edits go live on
  the next turn with no restart (and no watcher involvement). `tools/` is reloaded when a file under it changed; a
  reload that fails keeps the previous tools, logs why, and tells the agent in its system prompt on every turn until
  the fix loads. `start` does the same.
  - **Only TypeScript** (`.ts`, `.mts`, `.cts`, `.tsx`). A `.js`, `.mjs`, `.cjs` or `.json` file under `tools/` is
    loaded by Node itself, which keeps it as first read — as in pi's `/reload`. Editing one restarts the `dev`
    worker; under `start` it logs that a restart is needed, and nothing is reported as reloaded.
  - **A failed reload is retried when a file under `tools/` changes** — not when a helper outside it does, and not
    when a secret is set: secrets are read at startup, so a missing one needs a restart.
  - **Tools have their own copy of local modules.** A reload re-reads the local files a tool imports, so tools load
    them apart from `channels/` and `routines/` — from boot, not only after a reload. A `lib/queue.ts` both a channel
    and a tool import is two queues. State they must share belongs in an installed package (Node loads those once)
    or outside the process.
  - **Module state is not carried over, and not cleaned up.** A reload evaluates `tools/` again as a whole: a helper
    your tools share is still one instance, but a new one, and the old one is not closed — its connection pool,
    `setInterval` or `process.on` listener stays alive beside the new one, once more per reload. Open resources when
    a tool is called, not at the top of the module.
- **Code inputs** (`channels/`, `routines/`, `fastagent.config.ts`, `package.json`, `.secrets/.env`, and `.js`/`.mjs`/`.cjs`/`.json`
  files under `tools/`) restart the dev worker. So does a TypeScript fix under `tools/` when the worker is down —
  one that refused a broken tool at boot.

Nothing else is watched: files the agent itself writes into the workspace (its work product) never
trigger a restart. Helper code a tool imports from outside `tools/` is reloaded only when something under `tools/`
changes — keep it under `tools/`. A `channels/` helper outside `channels/` needs a manual restart. (`fastagent chat` is a startup snapshot — restart it
to pick up any edit.)

If the worker stopped after a broken code edit, save another change after fixing the error. The supervisor should retry.

Use `--no-watch` to serve once without the supervisor.

## Sessions disappear after redeploy

By default, machine state (sessions, channel state, schedule state) lives under the agent's
`.state/`, and the seeded/rotated credentials (`auth.json`) under its `.secrets/`:

```txt
<state root>    # default <agent dir>/.state
<secrets dir>   # default <agent dir>/.secrets
```

A redeploy that replaces the agent wipes both. Point each at durable storage (the generated
deploy targets set both):

```bash
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

Sessions have no separate knob — moving them alone was never enough for a channel-backed deployment
(Telegram's durable turn state lives under the same state root), so the state root moves all of it.
Moving only the state root still leaves a rotated `auth.json` in the agent dir — set
`FASTAGENT_SECRETS_DIR` too.

## `session busy`

Only one turn can write to a session at a time. A concurrent turn on the same session fails fast with a retryable `failed` event.

Fixes depend on the channel:

- use distinct sessions for independent work,
- debounce duplicate webhook events,
- retry later for chat-style follow-ups,
- design tools to be idempotent if events can overlap.

## Tool, channel or schedule failed to load

An enabled file under `tools/`, `channels/` or `routines/` is a declaration of what this agent has. If
it cannot import, validate its required environment, or return a valid export, `dev` / `start` fails
naming every file that failed, instead of running an agent short a tool, dropping an endpoint back to
`/invoke`, or reporting itself ready with a cron that will never fire.

Fix the reported files and environment. To intentionally disable one without deleting it, rename it so
it no longer ends in `.ts`, `.js`, or `.mjs`, for example:

```bash
mv channels/telegram.ts channels/telegram.ts.disabled
```

`fastagent info` is the exception: it loads what it can and reports the rest, so it still works on a
definition that cannot start.

## Webhook not receiving events locally

For local webhook development:

```bash
fastagent dev --tunnel
```

Check:

- `cloudflared` is installed,
- the public URL printed by FastAgent is the one configured in the provider,
- the route path matches the channel (`/webhook` for GitHub, `/telegram` for Telegram, `/slack` for Slack, `/feishu` for Feishu, `/lark` for Lark),
- the provider secret matches your `.env`,
- your `.env` is loaded from the agent's `.secrets/` directory.

## GitHub webhook returns 401

The `GITHUB_WEBHOOK_SECRET` in `.env` must match the secret configured in GitHub webhook settings.

Also check that GitHub sends `application/json` or its form-encoded payload format; both are supported by the first-party adapter.

## Telegram webhook returns 401

The `x-telegram-bot-api-secret-token` header must match `TELEGRAM_SECRET_TOKEN`.

If using `fastagent dev --tunnel`, rerun after changing `.env` so the webhook registration uses the new token.

## Telegram messages send no final reply

Check:

- `TELEGRAM_BOT_TOKEN` is set,
- the bot is allowed to message the chat,
- group messages match the route policy (private chat, reply to bot, or `@botname` mention by default),
- model credentials are configured,
- the operator log for a `failed` event or Bot API error.

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
fails the turn visibly; earlier buffered files degrade individually. See [Slack channel](slack.md).

## Images are ignored or fail

Telegram and Slack images become `prompt.images`. The selected model must support vision. If it does not, choose a vision-capable model or route image messages differently.

## Files are not found by the agent

Telegram documents/audio/video and Slack files are downloaded under:

```txt
<state root>/channels/telegram/files/c-<chat>/
<state root>/channels/slack/files/c-<channel>/
```

The directory is `c-` followed by the URL-encoded conversation id, so an id carrying `/` or `:`
(a Feishu thread, a custom route's own id) still names one directory: `oc_x:thread/1` is stored as
`c-oc_x%3Athread%2F1`. The full path is appended to the prompt. Make sure the agent has filesystem tools enabled.

These files are kept across restarts and never pruned by FastAgent, so an ENOENT here means the state
root moved (check `FASTAGENT_STATE_DIR` and, on a deployed box, that the volume is mounted) or something
outside FastAgent removed them. The flip side is that the directory grows with every inbound file: it is
yours to size and prune.

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

Re-run `fastagent add feishu` (or `add lark`) and choose **Context-aware groups (recommended)**. The
CLI adds the sensitive `im:message.group_msg` scope to the app draft when the cloud control plane allows
it, then opens Permissions for tenant-admin approval; complete that approval and publish a new app
version. If the CLI reports a Lark config-API fallback, add the scope manually. A serving process reports
`group visibility: @mentions only` until the granted scope is visible. See the
[Feishu channel](feishu.md) guide.

## Schedule did not fire

Cron schedules fire only while a serving process is up:

- `fastagent dev` or `fastagent start` must be running at the cron instant; `invoke` and `routine run` do
  not start the scheduler,
- a run missed while the process was down is caught up once on the next start, not once per missed
  slot,
- a scaled-to-zero deployment sleeps through cron instants; keep one machine running — or keep the time in a scheduler you own and let it call [`POST /run`](api-reference.md#post-run) (see
  [Deploy](deploy.md)).

Diagnose with commands that exit:

```bash
fastagent routine list             # everything that will fire, with the next instant
fastagent routine history <name>   # did last night's run silently fail?
fastagent routine run <name>      # run the schedule's turn now, without touching cron state
```

A broken `routines/<name>.ts` file is reported by `fastagent info` before it ever reaches `dev`.

## Deployed agent crash-loops with `missing model`

`deploy` resolves the model in **the environment being deployed**, not in yours. That environment is
declared by `.secrets/.env`, so its `FASTAGENT_MODEL` is recorded in the release manifest
(`fastagent.release.json`), with `model` in `fastagent.config.ts` as the fallback (the config file ships
too). A `FASTAGENT_MODEL` exported in your shell belongs to this machine's environment and never
reaches the box, and `deploy` has no `--model` flag. Set a source and redeploy — `deploy` prints the
effective model and where it read it. Note the manifest's value outranks the deployed box's own
`.secrets/.env`, so switching models means editing the source here and redeploying, not editing the
file on the box. See [Deploy](deploy.md).

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

Then retry `fastagent login`, `fastagent dev`, or `fastagent start`. The variables may also live in the agent's
`.secrets/.env` — every command reads it before deciding where its requests go, so a tool's `fetch`, a channel's
app-creation flow and a skill download all follow the same proxy.

Loopback (`localhost`, `127.0.0.1`, `::1`) always stays direct — it is added to whatever `NO_PROXY` you set, so a proxy
variable does not break local health probes, a control-plane client, or an `ssh -L`
forward. A LAN address is not loopback: if you run `fastagent dev --bind 192.168.1.5`, a client that dials that address
sends it through the proxy — put it in `NO_PROXY` yourself.

## Need a machine-readable report

Use:

```bash
fastagent info --json
```

This is useful in CI and bug reports.
