---
title: Troubleshooting
status: current
---

# Troubleshooting

Common FastAgent setup and runtime issues.

## `missing model`

FastAgent needs a model spec such as `openai-codex/gpt-5.5`. In a terminal, `dev` / `start` /
`invoke` prompt you to pick one from the providers you are logged into (run `fastagent login` first)
and save it. This error means the run is **non-interactive** (CI, a container, a piped command) with
no model set.

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

Options:

```bash
fastagent login
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

- **AGENTS.md and `skills/`** are re-read on every turn — edits go live on the next turn with no
  restart (and no watcher involvement).
- **Code inputs** (`tools/`, `channels/`, `fastagent.config.*`, `package.json`, `.env`) restart the
  dev worker — a new process is the only way to drop the ESM module cache.

Nothing else is watched: files the agent itself writes into the workspace (its work product) never
trigger a restart. Helper code imported from outside `tools/`/`channels/` is out of watch scope —
keep it under `tools/`, or restart manually. (`fastagent chat` is a startup snapshot — restart it
to pick up any edit.)

If the worker stopped after a broken code edit, save another change after fixing the error. The supervisor should retry.

Use `--no-watch` to serve once without the supervisor.

## Sessions disappear after redeploy

By default, sessions live under the workspace:

```txt
<state root>/sessions   # default <workspace>/.fastagent/sessions; root override: FASTAGENT_STATE_DIR
```

A redeploy that replaces the workspace can wipe them. Point sessions at durable storage:

```bash
FASTAGENT_SESSIONS_DIR=/data/sessions fastagent start
# or
fastagent start --sessions-dir /data/sessions
```

## `session busy`

Only one turn can write to a session at a time. A concurrent turn on the same session fails fast with a retryable `failed` event.

Fixes depend on the channel:

- use distinct sessions for independent work,
- debounce duplicate webhook events,
- retry later for chat-style follow-ups,
- design tools to be idempotent if events can overlap.

## Webhook not receiving events locally

For local webhook development:

```bash
fastagent dev --tunnel
```

Check:

- `cloudflared` is installed,
- the public URL printed by FastAgent is the one configured in the provider,
- the route path matches the channel (`/webhook` for GitHub scaffold, `/telegram` for Telegram scaffold),
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
