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
# or fastagent.config.mjs: { model: "provider/modelId" }
```

Precedence:

```txt
--model > FASTAGENT_MODEL > fastagent.config.* model
```

## `auth: (none found)`

The selected provider has no credentials.

Most common cause: you ran `fastagent login` **from a different directory**. Login is project-level —
it writes `<cwd>/.fastagent/auth.json`, and there is no fallback to the global file. Run it inside the
workspace, or point every project at one shared file with `FASTAGENT_AUTH_PATH=~/.fastagent/auth.json`.

Options:

```bash
cd <workspace> && fastagent login
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

- the workspace ran `npm install`,
- dependencies used by tools are in the workspace `package.json`,
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

- **persona.md, AGENTS.md, and `skills/`** are re-read on every turn — edits go live on the next turn
  with no restart (and no watcher involvement).
- **Code inputs** (`tools/`, `channels/`, `fastagent.config.*`, `package.json`, `.env`) restart the
  dev worker — a new process is the only way to drop the ESM module cache.

Nothing else is watched: files the agent itself writes into the workspace (its work product) never
trigger a restart. Helper code imported from outside `tools/`/`channels/` is out of watch scope —
keep it under `tools/`, or restart manually. (`fastagent chat` is a startup snapshot — restart it
to pick up any edit.)

If the worker stopped after a broken code edit, save another change after fixing the error. The supervisor should retry.

Use `--no-watch` to serve once without the supervisor.

## Sessions disappear after redeploy

By default, all machine state (auth, sessions, channel state) lives under the workspace:

```txt
<state root>   # default <workspace>/.fastagent
```

A redeploy that replaces the workspace wipes it. Point the whole state root at durable storage:

```bash
FASTAGENT_STATE_DIR=/data/fastagent fastagent start
```

Moving only sessions (`FASTAGENT_SESSIONS_DIR` / `--sessions-dir`) is not enough for channel-backed
deployments — Telegram's durable turn state also lives under the state root.

## `session busy`

Only one turn can write to a session at a time. A concurrent turn on the same session fails fast with a retryable `failed` event.

Fixes depend on the channel:

- use distinct sessions for independent work,
- debounce duplicate webhook events,
- retry later for chat-style follow-ups,
- design tools to be idempotent if events can overlap.

## Channel failed to load

A file under `channels/` is an enabled channel declaration. If it cannot import, validate its required
environment, or return valid routes, `dev` / `start` fails instead of silently dropping that endpoint or
falling back to `/invoke`.

Fix the reported file and environment. To intentionally disable a channel without deleting it, rename it
so it no longer ends in `.ts`, `.js`, or `.mjs`, for example:

```bash
mv channels/telegram.ts channels/telegram.ts.disabled
```

## Webhook not receiving events locally

For local webhook development:

```bash
fastagent dev --tunnel
```

Check:

- `cloudflared` is installed,
- the public URL printed by FastAgent is the one configured in the provider,
- the route path matches the channel (`/webhook` for the GitHub scaffold, `/telegram` for Telegram, `/feishu` for Feishu, `/lark` for Lark),
- the provider secret matches your `.env`,
- your `.env` is loaded from the workspace directory.

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

## Images are ignored or fail

Telegram photos become `prompt.images`. The selected model must support vision. If it does not, choose a vision-capable model or route image messages differently.

## Files are not found by the agent

Telegram documents/audio/video are downloaded under:

```txt
<state root>/channels/telegram/files/<chat>/
```

The path is appended to the prompt. Make sure the agent has filesystem tools enabled and the file still exists. Long-running bots should mount or clean this directory deliberately.

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

To receive them, add the sensitive `im:message.group_msg` scope (custom apps only, tenant-admin
approval) and publish a new app version. See the [Feishu channel](feishu.md) guide.

## Schedule did not fire

Cron schedules fire only while a serving process is up:

- `fastagent dev` or `fastagent start` must be running at the cron instant; `invoke` and `fire` do
  not start the scheduler,
- a run missed while the process was down is caught up once on the next start, not once per missed
  slot,
- a scaled-to-zero deployment sleeps through cron instants; keep one machine running (see
  [Deploy](deploy.md)).

Diagnose with commands that exit:

```bash
fastagent schedule list             # everything that will fire, with the next instant
fastagent schedule history <name>   # did last night's run silently fail?
fastagent fire <name>               # run the schedule's turn now, without touching cron state
```

A broken `schedules/<name>.ts` file is reported by `fastagent info` before it ever reaches `dev`.

## Deployed agent crash-loops with `missing model`

The deployed box reads the model only from `fastagent.config.*`. A builder-local `--model` flag,
`FASTAGENT_MODEL`, or `.env` value does not travel (`.env` is dockerignored). Set
`model: "provider/id"` in the config file and redeploy. See [Deploy](deploy.md).

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

Then retry `fastagent login`, `fastagent dev`, or `fastagent start`.

## Need a machine-readable report

Use:

```bash
fastagent info --json
```

This is useful in CI and bug reports.
