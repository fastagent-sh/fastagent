---
title: Configuration
description: "Configure a FastAgent workspace: model selection, auth, ports, sessions, tools, channels, state paths, and deploy options in fastagent.config.*."
status: current
---

# Configuration

FastAgent keeps behavior and deployment choices separate:

- agent behavior lives in `persona.md` (identity), `skills/`, `tools/`, and `AGENTS.md` project context,
- deployment choices live in `fastagent.config.*`, CLI flags, and environment variables,
- secrets live in `<workspace>/.secrets/` (`.env` + the project-level `auth.json`) or provider env vars.

## Config file

A workspace may contain exactly one config file:

```txt
fastagent.config.ts
fastagent.config.js
fastagent.config.mjs
```

Example:

```ts
import { defineConfig } from "@fastagent-sh/fastagent";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
});
```

Supported keys:

| Key | Meaning |
|---|---|
| `model` | Default model spec, in `provider/modelId` form. |
| `thinkingLevel` | Reasoning effort for the model, on pi's scale: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. Default: `medium` — pinned by fastagent to match the pi TUI's default (authors vibe at `medium`, so serving must match; the pin also means an upstream default change cannot silently alter deployments). Levels a model doesn't support are clamped by the engine. |
| `tools` | Extra programmatic tools appended after default pi tools. Most users should prefer `tools/` discovery. |
| `http.port` | Default port for `dev` / `start`. |
| `selfSchedule` | Mount the built-in `wake` tool so the agent can schedule its own follow-up turns (self-scheduling). Off by default — an autonomy capability, opt in when you want it; only active on the serving path (`dev`/`start`, where the scheduler poller runs). |
| `sessionControl` | Serve the session control plane at `/control/*` (state/entries/live events + dispatch: steer/abort/compact/set_model…) for remote consumers — a Web panel, a desktop app, `fastagent attach`. Off by default (it is a remote-control surface). When on, `dev`/`start` mint a per-boot bearer token into `<stateRoot>/control.json`; the serve binds all interfaces, so the routes are LAN-reachable with the token as the only protection — firewall the port or wrap it. On a deployed box (`fastagent deploy`) the routes ride the public host URL with the token minted inside the container: read `<stateRoot>/control.json` on the box, or front the endpoint with real auth; `deploy` warns about this. |
| `deploy.secrets` | Extra secret env-var names the deployed agent needs (e.g. `["GH_TOKEN"]`). `deploy` lists them in the runbook and, under `--run`, carries each value from your local env to the host secret store; a missing value gates the run. |
| `deploy.apt` | Extra apt packages baked into the generated image (`["git", "ripgrep"]` — Debian default repos). For a package needing a custom apt repo (e.g. `gh`) or a different base image, provide your own `Dockerfile` — `deploy` keeps an existing one (and warns that `deploy.apt` isn't applied to a hand-written Dockerfile). A `Dockerfile` fastagent generated that later drifts from the current config (a changed `deploy.apt`, a new lockfile) is kept but flagged stale; `--force` regenerates it. |

Unknown keys fail at startup. This catches typos such as `modle` instead of silently running zero-config.

The generated `.dockerignore` excludes `.git` to keep the image small. If your agent runs git over its **own** history (e.g. `git log`/`git blame` on the repo it ships in), delete the `.git` line from the generated `.dockerignore` so that history is included in the image.

## Model selection

Model specs are strings like:

```txt
provider/modelId
```

List available specs:

```bash
fastagent models
fastagent models gpt
```

Precedence:

```txt
CLI --model > FASTAGENT_MODEL > fastagent.config.* model
```

With none of these set, a serving command (`dev` / `start` / `invoke`) run in a terminal prompts you
to pick from the full model catalog (ready providers first, annotated with the credential source;
a pick that needs auth runs `login` inline), then writes the choice back to the config. Non-interactive runs (CI, a container) skip the prompt and fail with a clear `missing model`
error instead — set one of the sources above.

Examples:

```bash
fastagent dev --model openai-codex/gpt-5.5
FASTAGENT_MODEL=openai-codex/gpt-5.5 fastagent start
```

## Auth and secrets

FastAgent resolves model credentials through the model provider layer. Common options:

| Source | Use case |
|---|---|
| `fastagent login` | Stores OAuth/API-key credentials in the project-level `<workspace>/.secrets/auth.json` (override: `--auth-path` / `FASTAGENT_AUTH_PATH`, a leading `~` is expanded; run from `$HOME` for the global `~/.fastagent/.secrets/auth.json`). |
| Provider env vars | Good for servers and CI, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| Workspace `.env` | Local development secrets at `<workspace>/.secrets/.env`, loaded by CLI commands. The `.secrets/` dir self-gitignores. |

Do not commit `.env` or provider credentials.

Run `fastagent info` or `fastagent dev` to see the resolved auth source for the selected provider.

## Ports

Port precedence for `dev`:

```txt
--port > fastagent.config.* http.port > 8787
```

Port precedence for `start`:

```txt
--port > PORT > fastagent.config.* http.port > 8787
```

Use `PORT` in hosted environments that inject a port.

## Machinery: `.state/` and `.secrets/`

The workspace carries two fastagent-managed machinery dirs, split by deploy lifecycle:

- `<workspace>/.state/` — **mutable machine state**: sessions, channel state (`channels/<kind>/`),
  schedule state. Precious, single-process, must survive a redeploy → a container points it at a
  volume.
- `<workspace>/.secrets/` — **secrets**: the workspace `.env` and the project-level `auth.json`.
  Never committed (the dir self-gitignores; only `.env.example` travels), never baked into an image —
  a deployed box gets values through the host's secret store, and its seeded (possibly rotated)
  `auth.json` also lives on the volume so refresh survives restarts.

For deployments, point both at durable storage:

```bash
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

The finer knobs still override their specific path on top:

```txt
state root: FASTAGENT_STATE_DIR                          > <workspace>/.state
secrets:    FASTAGENT_SECRETS_DIR                        > <workspace>/.secrets
sessions:   --sessions-dir > FASTAGENT_SESSIONS_DIR      > <state root>/sessions
auth:       --auth-path    > FASTAGENT_AUTH_PATH         > <secrets>/auth.json
```

A leading `~` in any of these is expanded to your home dir.

`FASTAGENT_SECRETS_DIR` moves both the workspace `.env` and `auth.json`. The `.env`'s own location
resolves from the real environment — a `FASTAGENT_SECRETS_DIR` set *inside* `.env` still relocates
`auth.json` but cannot move the file it is read from. The committable `.env.example` template always
stays at `<workspace>/.secrets/.env.example`.

## Tools

There are two ways to add tools:

1. Files under `tools/` — recommended for workspace authors.
2. `config.tools` — programmatic injection for advanced embedding/config use.

`tools/` files are auto-discovered. The filename is the tool name:

```txt
tools/lookup-order.ts  ->  lookup-order
```

`config.tools` are appended after the default pi tools. Discovered `tools/` are appended after those.
Name collisions are surfaced as warnings; existing tools win. Reusable packages do not need a separate
plugin contract: export ordinary `FastagentTool[]` and mount them explicitly:

```ts
import { integrationTools } from "@acme/fastagent-tools";

export default defineConfig({
  tools: integrationTools({ apiKey: process.env.ACME_API_KEY! }),
});
```

Package tools receive the same `ToolContext` as definition-local `defineTool` tools, including the
optional read-only `sessionManager` during serving/chat turns.

### When the repo already owns `tools/` or `channels/`

Use the **standalone layout** (the whole workspace in `./.fastagent/`) so FastAgent scans the
workspace's own directories instead of the host repo's names; `fastagent init` chooses this layout
automatically when those directories are occupied (the layout is structural — detected from the
directory shape, never configured). Within the workspace, a broken tool is reported and skipped, while
a broken declared channel fails serving — an inbound endpoint must not silently disappear. If you want
programmatic tools outside the workspace, declare them with `config.tools`.

## Channels

Channels are not configured in `fastagent.config.*`. A channel needs glue code, so its file is the
enable switch: `.ts` / `.js` / `.mjs` files under `channels/` are enabled; rename one to
`<name>.ts.disabled` to disable it without introducing a second config source.

```txt
channels/github.ts
channels/telegram.ts
```

See [Channels](channels.md).

## Logging

Log verbosity is an environment knob, not a config key. `FASTAGENT_LOG_LEVEL` (`debug` | `info` | `warn` | `error`) overrides the per-posture default: `dev` defaults to `debug`, `start` to `info`. Per-turn traces log at `debug`, so `start` keeps end-user content out of production logs unless you opt into `debug`.

```bash
FASTAGENT_LOG_LEVEL=debug fastagent start
```

## What is deliberately not config

The following are library API injection points rather than config keys:

- custom session stores,
- custom execution environments (a complete sandbox adapter remains future work),
- distributed leases,
- custom model providers,
- base prompt overrides.

Use the library API in [Embedding](embedding.md) when you need those ports.
