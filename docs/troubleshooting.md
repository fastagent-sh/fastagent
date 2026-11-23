---
title: Troubleshooting
description: "Quick fixes for common FastAgent setup, local development, OS sandbox, remote authentication, and deployment issues."
status: current
---

# Troubleshooting

Look up the error message or symptom below. When filing an issue, include the output of `fastagent info --json`.

## Setup & development

### `missing model`

**Why:** No default model is configured and there is no interactive terminal to ask.
**Fix:** Set a model explicitly (run `fastagent models [search]` to see valid `provider/modelId` specs):

```bash
fastagent dev --model provider/modelId           # one run
FASTAGENT_MODEL=provider/modelId fastagent dev   # shell or container
# or set `model` in fastagent.config.ts          # permanent default
```

### `auth: (none found)`

**Why:** The selected provider has no credentials for this agent. Local credentials are stored per agent in `.secrets/auth.json` (plus `~/.fastagent/.secrets/auth.json` for `fastagent login -g`).
**Fix:** Run `fastagent login` in the agent directory, or add the provider's API key (such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) to `.secrets/.env`.

### A tool or extension fails to load

**Why:** `Cannot find package`, `Unexpected token 'export'`, or a refusal naming a file under `src/`.
**Fix:**
- Run `npm install` and verify `package.json` has `"type": "module"`.
- Put only tool/extension modules with default exports directly inside `src/tools/` or `src/extensions/`. Move helper modules outside `src/` (for example into `lib/`).
- Use `.ts` extensions on relative imports (`../lib/helper.ts`) and `import type` for type-only imports.

### `Invalid schema for function '...'`

**Why:** Some model providers (notably OpenAI) only accept a narrow set of JSON Schema `format` values (`date-time`, `date`, `email`, `uuid`, …) and reject others like `format: "uri"`.
**Fix:** Replace unsupported string formats with a regex pattern (`pattern: "^https?://\\S+$"` in JSON Schema, `z.string().regex(/^https?:\/\/\S+$/)` in Zod, or `str({ pattern: "^https?://\\S+$" })` in `pi-schema`).

### Port already in use

**Fix:** Pass `--port 8788` (or set `PORT=8788` for `fastagent start`).

### `the storage ... is held by another process`

**Why:** Only one process can own an instance's SQLite file (or PostgreSQL lease) at a time. Another `fastagent dev`, `fastagent start`, or standalone `fastagent invoke` currently holds it.
**Fix:** Stop the other process—or keep `fastagent dev` running so `fastagent invoke` connects to it automatically over its Agent API.

## Local development

### `dev` does not pick up a change

- Edits to `SYSTEM.md`, `AGENTS.md`, `skills/`, and `prompts/` apply automatically on the next message.
- Edits to `src/`, `fastagent.config.ts`, `package.json`, and `.secrets/.env` restart the worker cleanly once active turns finish.
- Files outside `src/` (such as `lib/`) are not watched—restart `fastagent dev` manually after editing them.

### `busy` error on send

**Why:** The session's queue is full (`details.reason: "queue_full"`), the process hit capacity (`"capacity"`), or the request specified `whenBusy: "reject"` while a turn was running (`"running"`).
**Fix:** Use separate sessions for independent work, or send with `whenBusy: "queue"` or `"steer"`.

### Proxy or corporate network errors

**Fix:** Set `HTTPS_PROXY` (and `HTTP_PROXY` / `NO_PROXY`) in your shell or `.secrets/.env`. Loopback addresses bypass proxies automatically; add custom LAN addresses to `NO_PROXY`.

## Harnesses & OS sandboxing

### `harness "dsh" requires @fastagent-sh/harness-dsh`

**Why:** `@fastagent-sh/harness-dsh` is an optional package loaded lazily so core stays lightweight.
**Fix:** Install it in your agent directory:

```bash
npm install @fastagent-sh/harness-dsh
```

### DSH sandbox refuses to start

**Why:** With `harness: "dsh"` and `sandbox: "workspace"` or `"read-only"`, `bash` fails closed if the host OS cannot enforce confinement (for example inside a restricted container without user namespaces for `bwrap` or Landlock support).
**Fix:** Grant the required sandbox capability, rely on container isolation with `--sandbox off`, or disable `bash` via `codingTools: ["read"]` or `codingTools: false`.

### Extensions are skipped on `dsh`

**Why:** Modules in `src/extensions/` use `pi-durable`'s extension API and are skipped with a startup warning on `harness: "dsh"`.
**Fix:** Move portable tool logic into `src/tools/` using `defineTool` from `@fastagent-sh/fastagent`, or use `mcpServers`—both run identically on `pi-durable` and `dsh`.

## Remotes & remote auth

### `Remote "..." uses transport "agentcore"; install @fastagent-sh/client-agentcore`

**Why:** Non-HTTP entries in `~/.config/fastagent/remotes.json` dynamically load `@fastagent-sh/client-<type>`.
**Fix:** Install `@fastagent-sh/client-agentcore` in the environment where you run `fastagent` or Pi.

### `unauthorized` vs `auth_required` on a remote call

- **`unauthorized` (HTTP 401):** Your **server API key** (`FASTAGENT_API_KEY`, `--key`, or `apiKey` in `remotes.json`) was missing or rejected by the FastAgent server (or AWS IAM rejected your AgentCore invocation).
- **`auth_required` (in `message.error`):** The FastAgent server accepted your request, but the **model provider** inside the deployment has no valid credential. Set the provider's API key on the host or run `fastagent login <provider> --remote <name>`.

## Deployment

### Sessions disappear after a redeploy

**Why:** Instance state is being written to ephemeral container storage.
**Fix:** Mount a persistent volume at `/data` (the generated container's `FASTAGENT_ROOT`) or set `FASTAGENT_DATABASE_URL` to PostgreSQL / Aurora DSQL.

### `deploy init` or `deploy check` fails, or the container exits on boot

- **`persistent storage is not mounted at /data`:** Attach a persistent volume at `/data` (`-v <name>-data:/data`). Generated containers (`FASTAGENT_DEPLOYED=1`) always require a mounted `/data` volume for working files and the deployment lease, even when sessions are stored in PostgreSQL via `FASTAGENT_DATABASE_URL`.
- **`FASTAGENT_NAME is required for a deployment`:** Ensure your `Dockerfile` sets `ENV FASTAGENT_NAME=<name>` (or pass it in container env).
- **Build context leak reported:** Your `.dockerignore` is missing or does not exclude `.secrets/`, `.env*`, `.state/`, or `.fastagent/`. Update `.dockerignore` or run `fastagent deploy init <target> --force` to regenerate the FastAgent-managed file.
