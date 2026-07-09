---
title: Configuration
status: current
---

# Configuration

FastAgent keeps behavior and deployment choices separate:

- agent behavior lives in `AGENTS.md`, `skills/`, and `tools/`,
- deployment choices live in `fastagent.config.*`, CLI flags, and environment variables,
- secrets live in `.env`, provider env vars, or the project-level `<state root>/auth.json` (default `<dir>/.fastagent/auth.json`).

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
| `agentDir` | The agent-definition subdirectory (`persona.md`, `skills/`, `tools/`, `channels/`), relative to the config file. Default: the config directory itself (flat). Set it to e.g. `"./agent"` to serve an existing repo as a coding agent — the config directory stays the run root (`cwd`, whose `AGENTS.md` is read as context), while the agent's own surface lives in the subdir and does not collide with the host's `tools/`/`src/`. Must exist, stay inside the config directory, and be a real directory — a missing path is refused at load (a typo would otherwise silently serve an empty agent), and so is a symlink (its target can escape the config directory, where `dev`'s watch would never see edits). |
| `tools` | Extra programmatic tools appended after default pi tools. Most users should prefer `tools/` discovery. |
| `http.port` | Default port for `dev` / `start`. |
| `selfSchedule` | Mount the built-in `wake` tool so the agent can schedule its own follow-up turns (self-scheduling). Off by default — an autonomy capability, opt in when you want it; only active on the serving path (`dev`/`start`, where the scheduler poller runs). |
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
to pick from the models of the providers you are logged into, then writes the choice back to the
config. Non-interactive runs (CI, a container) skip the prompt and fail with a clear `missing model`
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
| `fastagent login` | Stores OAuth/API-key credentials in the project-level `<state root>/auth.json` (default `<cwd>/.fastagent/auth.json`; override: `--auth-path` / `FASTAGENT_AUTH_PATH`, a leading `~` is expanded; run from `$HOME` for the global file). |
| Provider env vars | Good for servers and CI, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| Workspace `.env` | Local development secrets loaded by CLI commands. Keep it gitignored. |

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

## Sessions

`<workspace>/.fastagent/` is the agent's **machine-state home**: sessions, credentials (`auth.json`),
and channel state (`channels/<kind>/`) all live under one root with one lifecycle — precious,
single-process, must survive a redeploy. It is gitignored and never part of the definition.

For deployments, move the WHOLE root to durable storage with one knob:

```bash
FASTAGENT_STATE_DIR=/data fastagent start
```

Everything derives from it (`/data/sessions`, `/data/auth.json`, `/data/channels/telegram`, …), so a
container mounts one volume. The finer knobs still override their specific path on top:

```txt
state root: FASTAGENT_STATE_DIR                          > <workspace>/.fastagent
sessions:   --sessions-dir > FASTAGENT_SESSIONS_DIR      > <state root>/sessions
auth:       --auth-path    > FASTAGENT_AUTH_PATH         > <state root>/auth.json
```

A leading `~` in any of these is expanded to your home dir.

## Tools

There are two ways to add tools:

1. Files under `tools/` — recommended for workspace authors.
2. `config.tools` — programmatic injection for advanced embedding/config use.

`tools/` files are auto-discovered. The filename is the tool name:

```txt
tools/lookup-order.ts  ->  lookup-order
```

`config.tools` are appended after the default pi tools. Discovered `tools/` are appended after those. Name collisions are surfaced as warnings; existing tools win.

### When the repo already owns `tools/` (or `channels/`)

Turning an existing repo into an agent, those directory names may already hold the repo's OWN scripts, not fastagent tools. That is fine: fastagent imports each file, and any that isn't usable — a failed import, no valid tool/channel export, or (for a channel) a factory that throws when called — is **isolated: reported as a warning and skipped, never crashing `start`**; the agent serves the tools that did load. If you want fastagent tools alongside the repo's `tools/`, declare them with `config.tools` (they don't have to live in the directory).

## Channels

Channels are not configured in `fastagent.config.*`. A channel needs glue code, so it is always a file under `channels/`.

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
- custom execution environments / sandboxes,
- distributed leases,
- custom model providers,
- base prompt overrides.

Use the library API in [Embedding](embedding.md) when you need those ports.
