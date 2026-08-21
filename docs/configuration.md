---
title: Configuration
description: "Configure a FastAgent agent: model selection, auth, ports, sessions, tools, channels, state paths, and deploy options in fastagent.config.*."
status: current
---

# Configuration

FastAgent keeps behavior and deployment choices separate:

- agent behavior lives in `persona.md` (identity), `skills/`, `tools/`, and `AGENTS.md` project context,
- deployment choices live in `fastagent.config.*`, CLI flags, and environment variables,
- secrets live in `<agent dir>/.secrets/` (`.env` + the project-level `auth.json`) or provider env vars.

## Config file

An agent may contain exactly one config file:

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
| `codingTools` | Select the built-in coding tools. Unset/`true`: all of `read`, `bash`, `edit`, `write`; `false`/`[]`: none; an array such as `["read"]`: exactly those names. Authored and conditional built-ins are independent. |
| `tools` | Extra programmatic tools appended after enabled pi coding tools. Most users should prefer `tools/` discovery. |
| `http.port` | Default port for `dev` / `start`. |
| `http.host` | Bind address for `dev` / `start`. Unset (or `0.0.0.0`) binds all interfaces — what containers need. `--bind` overrides it; prefer the flag for a local-only bind, since this value travels into a deployed image (see [Bind address](#bind-address)). |
| `selfSchedule` | Mount the built-in `wake` tool so the agent can schedule its own follow-up turns (self-scheduling). Off by default — an autonomy capability, opt in when you want it; only active on the serving path (`dev`/`start`, where the scheduler poller runs). |
| `sessionControl` | Serve the session control plane at `/control/*` (state/entries/live events + dispatch: steer/abort/compact/set_model…) for remote consumers — a Web panel, a desktop app, `fastagent attach`. Off by default (it is a remote-control surface). When on, `dev`/`start` mint a per-boot bearer token into `<stateRoot>/control.json`; the serve binds all interfaces by default, so the routes are LAN-reachable with the token as the only protection — bind loopback (`--bind 127.0.0.1` — not `http.host`, which travels into a deployed image), firewall the port, or wrap it. On a deployed box (`fastagent deploy`) the routes ride the public host URL with the token minted inside the container: read `<stateRoot>/control.json` on the box, or front the endpoint with real auth; `deploy` warns about this. |
| `deploy.secrets` | Extra secret env-var names the deployed agent needs (e.g. `["GH_TOKEN"]`). `deploy` lists them in the runbook and, under `--run`, carries each value from your local env to the host secret store; a missing value gates the run. |
| `deploy.apt` | Extra apt packages baked into the generated image (`["git", "ripgrep"]` — Debian default repos). For a package needing a custom apt repo (e.g. `gh`) or a different base image, provide your own `Dockerfile` — `deploy` keeps an existing one (and warns that `deploy.apt` isn't applied to a hand-written Dockerfile). A `Dockerfile` fastagent generated that later drifts from the current config (a changed `deploy.apt`, a new lockfile) is kept but flagged stale; `--force` regenerates it. |

Unknown keys fail at startup. This catches typos such as `modle` instead of silently degrading to defaults.

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

## Custom model endpoints

To run against something the built-in catalog does not know — a self-hosted model (vLLM, SGLang,
Ollama, LM Studio) or your own gateway/proxy — declare it in `models.json` **next to the config
file**, in the agent dir:

```txt
my-agent/
├── fastagent.config.ts
├── models.json        ← custom endpoints
└── persona.md
```

The file's existence is the switch; there is no config key for it. An endpoint needs a URL, an API
shape, a key, and the model ids it serves — everything else has a default:

```json
{
  "providers": {
    "mygw": {
      "baseUrl": "http://vllm.internal:8000/v1",
      "api": "openai-completions",
      "apiKey": "$MYGW_API_KEY",
      "models": [{ "id": "deepseek-v3", "contextWindow": 65536 }]
    }
  }
}
```

The provider id joins the model id into a normal spec, usable everywhere a spec is:

```ts
export default defineConfig({
  model: "mygw/deepseek-v3",
});
```

Custom endpoints are **additive** — built-in providers stay available alongside them.

### Keys stay out of the file

`apiKey` (and any `headers` value) resolves at request time: `"$MYGW_API_KEY"` reads an environment
variable, `"!cmd"` runs a command and uses its stdout, anything else is a literal. Prefer the env
form — the file then stays safe to commit and to bake into an image.

`deploy` recognizes the variable backing the selected model and carries its value to the host like any
provider key, listing it in the runbook and refusing `--run` when it has no local value. You do not
need to declare it. `deploy.secrets` remains for the variables `deploy` cannot infer — a key used only
in `headers`, or a value assembled from several variables (`"${A}_${B}"`):

```ts
export default defineConfig({
  model: "mygw/deepseek-v3",
  deploy: { secrets: ["MYGW_PORTKEY_KEY"] },
});
```

A key written INTO `models.json` (a literal, or a `!command` resolved on the host) travels with the
file itself, so there is nothing to carry — and `deploy` does not ask for one.

### Routing a built-in provider through a proxy

Give an existing provider a new `baseUrl` and nothing else. Its full model list, pricing metadata and
compatibility flags are kept, and existing OAuth / API-key auth keeps working:

```json
{
  "providers": {
    "deepseek": { "baseUrl": "https://llm-proxy.internal/v1" }
  }
}
```

### Compatibility flags

OpenAI-compatible servers differ in the details. `compat` (per provider, or per model to override)
carries the switches — e.g. `supportsDeveloperRole: false` for servers that reject the `developer`
role, or `thinkingFormat` for reasoning models behind a chat template.

The schema is pi's own; its full field reference, including every `compat` flag and per-model
override, is in pi's `docs/models.md` (`@earendil-works/pi-coding-agent`). Two things are specific to
FastAgent:

| Behavior | Why |
|---|---|
| pi's machine-global `~/.pi/agent/models.json` is **not** read | Deployment behavior must come from the bundled definition, not the builder machine — a globally-defined endpoint would work locally and vanish on deploy. |
| A malformed `models.json` fails startup | Upstream degrades silently to the built-ins; FastAgent surfaces the parse error instead of letting it resurface later as `unknown model`. |

`fastagent models` lists the built-in catalog only — it answers "what does FastAgent support", not
"what does this agent use". To confirm what an agent resolved, run `fastagent info`.

## Auth and secrets

FastAgent resolves model credentials through the model provider layer. Common options:

| Source | Use case |
|---|---|
| `fastagent login` | Stores OAuth/API-key credentials in the project-level `<agent dir>/.secrets/auth.json` (override: `--auth-path` / `FASTAGENT_AUTH_PATH`, a leading `~` is expanded; run outside any agent for the global `~/.fastagent/.secrets/auth.json` — announced on stderr). |
| Provider env vars | Good for servers and CI, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. |
| Agent `.env` | Local development secrets at `<agent dir>/.secrets/.env`, loaded by CLI commands. Excluded by the `.secrets/.gitignore` that `init` scaffolds. |

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

## Bind address

```txt
--bind > fastagent.config.* http.host > all interfaces
```

`localhost` is accepted and resolved to `127.0.0.1` as it is read, so what binds, what the startup
lines print and what `control.json` records are the same address — a name would leave that to
`dns.lookup` on one side and to the client's resolver on the other, which can disagree.

All interfaces is the default because containers require it. A desktop app driving a local agent wants
the opposite: `--bind 127.0.0.1` keeps the port — `/control/*` with it — unreachable from the LAN.
`<stateRoot>/control.json` records the address a client should dial, so clients read it rather than
assume one.

Two edges: `--tunnel` reaches the serve by dialing `localhost`, so a bind that name never resolves to
(`--bind 192.168.1.5`, or even `--bind 127.0.0.2`) is refused with it; and `http.host` travels into a deployed image, where any non-wildcard bind
breaks the container (unreachable, or unable to bind at all) — `deploy` warns and gates `--run`, so keep
the local-only choice on `--bind`.

## Machinery: `.state/` and `.secrets/`

The agent carries two fastagent-managed machinery dirs, split by deploy lifecycle:

- `<agent dir>/.state/` — **mutable machine state**: sessions, channel state (`channels/<kind>/`),
  schedule state. Precious, single-process, must survive a redeploy → a container points it at a
  volume.
- `<agent dir>/.secrets/` — **secrets**: the agent's `.env` and the project-level `auth.json`.
  The scaffolded `.secrets/.gitignore` keeps credential contents uncommitted. Deploy excludes those
  contents while shipping the tracked `.env.example` and `.gitignore` scaffolds, so no credential is
  baked into an image. A deployed box gets values through the host's secret store, and its seeded
  (possibly rotated) `auth.json` also lives on the volume so refresh survives restarts.

For deployments, point both at durable storage:

```bash
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

The finer knobs still override their specific path on top:

```txt
state root: FASTAGENT_STATE_DIR                          > <agent dir>/.state
secrets:    FASTAGENT_SECRETS_DIR                        > <agent dir>/.secrets
sessions:   --sessions-dir > FASTAGENT_SESSIONS_DIR      > <state root>/sessions
auth:       --auth-path    > FASTAGENT_AUTH_PATH         > <secrets>/auth.json
```

A leading `~` in any of these is expanded to your home dir.

`FASTAGENT_SECRETS_DIR` moves both the agent's `.env` and `auth.json`. The `.env`'s own location
resolves from the real environment — a `FASTAGENT_SECRETS_DIR` set *inside* `.env` still relocates
`auth.json` but cannot move the file it is read from. The committable `.env.example` template always
stays at `<agent dir>/.secrets/.env.example`.

## Tools

There are two ways to add tools:

1. Files under `tools/` — recommended for agent authors.
2. `config.tools` — programmatic injection for advanced embedding/config use.

`tools/` files are auto-discovered. The filename is the tool name:

```txt
tools/lookup-order.ts  ->  lookup-order
```

By default, `config.tools` are appended after the pi coding tools (`read`, `bash`, `edit`, `write`),
and discovered `tools/` are appended after those. To expose only authored tools:

```ts
import { defineConfig } from "@fastagent-sh/fastagent";

export default defineConfig({
  codingTools: false,
});
```

For least privilege while retaining file-backed capabilities, select only `read`:

```ts
export default defineConfig({
  codingTools: ["read"],
});
```

Model-visible skills are loaded on demand from their `SKILL.md` paths, and chat-channel non-image
attachments are downloaded to local paths. Both need the built-in `read` tool; FastAgent warns when
model-visible skills have no reader, and channels reject an explicitly attached file rather than hand
the model an unreadable path. Use `false` only when the agent needs neither capability (images still
travel inline through vision).

The setting removes only the selected coding tools. Authored `config.tools` and `tools/` still mount;
`search_tools` still mounts when a deferred tool needs it, and `wake` remains controlled by
`selfSchedule` on the serving path. Every directory-opening workflow (`dev`, `start`, `invoke`, `chat`,
`tool`, and `info`) resolves the same setting. Run `fastagent info --json` and inspect `codingTools`
(the resolved name array) plus `tools`.

Name collisions are surfaced as warnings; existing tools win. With a coding tool enabled, its name
wins over discovered tools; with it disabled, an authored tool may use that name. Reusable
packages do not need a separate plugin contract: export ordinary `FastagentTool[]` and mount them explicitly:

```ts
import { integrationTools } from "@acme/fastagent-tools";

export default defineConfig({
  tools: integrationTools({ apiKey: process.env.ACME_API_KEY! }),
});
```

Package tools receive the same `ToolContext` as definition-local `defineTool` tools, including the
optional read-only `sessionManager` during serving/chat turns.

## Extensions

Extension modules under `extensions/` travel with the definition. **They run in `fastagent chat`.
They are not loaded when serving** (`dev`, `start`, channels, a container) — see the split below,
which is a limitation of pi's extension runtime rather than a decision about your agent.

Two discovery shapes, matching pi:

```txt
extensions/notify.ts        ->  discovered
extensions/audit/index.ts   ->  discovered
```

pi's third shape — a subdirectory whose `package.json` declares a `pi` field — is not supported;
such a directory is warned about rather than skipped in silence. A symlinked entry is refused: an
extension reached through a link out of the definition resolves on your machine and is missing in
the container.

Only the definition's own `extensions/` are considered. The machine's `~/.pi` extensions are
deliberately not — a served agent must not depend on the authoring machine's setup.

### Why serving does not run them

pi's extension machinery is built for **one process serving one session**, which is what a terminal
is. Its own source calls the object holding a session's actions "the shared runtime", and every
`AgentSession` overwrites it on construction:

```js
// Copy actions into the shared runtime (all extension APIs reference this)
this.runtime.sendMessage = actions.sendMessage;
this.runtime.appendEntry = actions.appendEntry;
```

Serving is the opposite shape: one process, many concurrent turns, belonging to conversations that
have nothing to do with each other. With two turns in flight, the second one to start redirects
those actions to itself — so an extension calling `pi.sendMessage()` during the first turn can
deliver into the **other person's conversation**. The same sharing applies to the extension module
itself, and to `session_start` / `session_shutdown`, which stop being a matched pair once several
sessions share one instance.

That is a silent correctness failure, and a silently wrong answer is worse than a missing feature.
So serving does not load them, and warns at startup when a definition ships some.

This is fixable upstream, and narrowly: pi already has an uncached loader path that builds a fresh
module per call (jiti with `moduleCache: false`) and takes the runtime as an argument, which is
exactly per-session isolation. That function is not currently exported. When it is, serving can run
extensions with the same guarantees `chat` has today.

| | serving (`dev`, `start`, channels) | `chat` |
|---|---|---|
| discovery, and its refusals | runs | runs |
| tools it registers | **not mounted** | offered to the model |
| event and lifecycle handlers | **not run** | run |
| commands it registers | not executable | executable |
| `select` / `confirm` / `input` | — | shown to you |

If your extension's value is a slash command or a dialog, `chat` was always its home. If it
registers model-callable tools you need while served, write them as `tools/` — that is the path
built for serving, and it is concurrency-safe.

### When the repo already owns `tools/` or `channels/`

Nothing to do — the agent lives in `./fastagent/`, so FastAgent scans the agent's own directories,
never the workspace's names (the placement is structural — the `fastagent/` directory name is the
marker, nothing is configured). Within the agent, a broken tool is reported and skipped, while
a broken declared channel fails serving — an inbound endpoint must not silently disappear. If you want
programmatic tools outside the agent, declare them with `config.tools`.

### More than one agent

`fastagent/` is a fixed name, so a directory holds at most one agent. Give each agent its own
directory instead — that is what `init <name>` is for:

```bash
fastagent init reviewer     # reviewer/fastagent/
fastagent init releaser     # releaser/fastagent/
```

Each is fully independent: its own persona, skills, tools, config, model, channels, schedules,
`.state/` and `.secrets/`. Run them separately (`fastagent dev reviewer`), deploy them separately.

One consequence to know: an agent's workspace is always the directory holding its `fastagent/`, so
`reviewer`'s cwd is `reviewer/`, not the repo above it. Its `AGENTS.md` context still walks up to the
repo root (the ancestor walk), and its tools can reach the repo through `../`; if that matters for
your agent, say so in its `persona.md`.

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
- base prompt overrides.

Use the library API in [Embedding](embedding.md) when you need those ports.

Custom model providers are the exception that proves the rule: a *declarative* endpoint is definition
data, so it lives in the agent's own [`models.json`](#custom-model-endpoints). A provider that needs
CODE — minting a token per request, say — is still an injection point (`providers`, see
[Embedding](embedding.md)).
