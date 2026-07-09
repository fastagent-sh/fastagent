---
title: Quickstart
status: current
---

# Quickstart

This guide takes you from an installed CLI to a running local agent service.

## Prerequisites

- Node >= 22.19 (`node --version`).
- FastAgent CLI: `npm i -g @kid7st/fastagent`.
- Model credentials: run `fastagent login`, or put a provider API key in the workspace `.env`.

List available model specs with:

```bash
fastagent models
```

## 1. Create an agent workspace

```bash
fastagent init my-agent
cd my-agent
```

The default scaffold is a **self-iterating agent** — the directory is the agent, and it can edit its own definition (persona.md and skills are re-read every turn). A fresh workspace is minimal:

```txt
my-agent/
├── persona.md                         # the agent's identity — how to improve yourself
├── skills/writing-great-skills/       # the example skill: how to author skills well
├── tools/fetch-url.ts                 # an example code tool
├── fastagent.config.mjs
├── package.json
├── .env.example
└── .gitignore
```

`persona.md` teaches the agent to capture durable improvements as new skills; `writing-great-skills` (vendored from [mattpocock/skills](https://github.com/mattpocock/skills)) is the guide it consults to write them. No `AGENTS.md` is scaffolded — that file is *project context* the agent reads (yours, or a host repo's), not its identity. Add more skills with `fastagent add skill <owner/repo/path>`. For a workspace with no code tool or dependencies (persona.md + the skill + config only):

```bash
fastagent init my-agent --minimal
```

## 2. Inspect it

```bash
fastagent info
```

`info` is read-only. It prints the model, persona, context files (`AGENTS.md`), skills, discovered tools, channels, diagnostics, and session path without starting a server.

**Initializing inside an existing project?** When the directory is already claimed by a toolchain or deploy setup (a `tsconfig.json`/framework config, a non-JS build manifest like `go.mod`/`pyproject.toml`/`Cargo.toml`, a `Dockerfile`/`fly.toml`/`railway.toml`, or occupied `tools//channels//skills/`), `init` puts the agent kit into `./agent` instead of flat, writes `agentDir: "./agent"` into the config, and prints the reason — the host's build and the agent's surface never sweep each other, and the repo's own `AGENTS.md` is read as project context. Override with `--flat` or `--agent-dir <name>`.

A fresh workspace presets no model. On the first `fastagent dev` (or `start` / `invoke`) in a
terminal, FastAgent lists the models of the providers you are logged into (run `fastagent login`
first) and writes your pick back to `fastagent.config.mjs`. To set it non-interactively (or in
CI/deploy, where there is no prompt):

```bash
fastagent dev --model provider/model-id
FASTAGENT_MODEL=provider/model-id fastagent dev
# or edit fastagent.config.mjs
```

## 3. Run locally

```bash
fastagent dev
```

`dev` assembles the workspace and serves it on `:8787`. persona.md/AGENTS.md/`skills/` edits go live on the next turn; code edits (`tools/`, `channels/`, config) restart the worker. The default channel is `POST /invoke`.

Send one turn:

```bash
curl -N -X POST localhost:8787/invoke \
  -H 'content-type: application/json' \
  -d '{"session":"s1","text":"Summarize https://example.com in two bullets"}'
```

The response is Server-Sent Events. Events include `text`, optional `thinking`, tool events, and exactly one terminal `completed` or `failed`.

```txt
data: {"type":"tool_started","id":"tool-1","name":"fetch-url","args":{"url":"https://example.com"}}

data: {"type":"tool_ended","id":"tool-1","isError":false,"content":{"details":{"url":"https://example.com/","text":"Example Domain …"}}}

data: {"type":"completed"}
```

Reuse the same `session` value to continue a conversation. Local sessions persist under `<state root>/sessions` (default `.fastagent/sessions`), so a dev restart keeps conversation history.

## 4. Try authoring loops

Open the same assembled agent in pi's interactive TUI:

```bash
fastagent chat
```

Run one agent turn without a server:

```bash
fastagent invoke "Summarize persona.md in one sentence"
```

Run one tool without a model:

```bash
fastagent tool fetch-url '{"url":"https://example.com"}'
```

## 5. Add a tool

Tools are files in `tools/`. The filename is the tool name.

```ts
// tools/reverse.ts
import { defineTool, z } from "@kid7st/fastagent";

export default defineTool({
  description: "Reverse a string.",
  input: z.object({ text: z.string() }),
  async execute({ text }) {
    return { reversed: [...text].reverse().join("") };
  },
});
```

Test it directly:

```bash
fastagent tool reverse '{"text":"hello"}'
```

Mention the tool in `persona.md` so the model knows when to use it. `fastagent dev` reloads on save.

## 6. Serve without watch

```bash
fastagent start
```

`start` uses the same assembly as `dev`, but does not watch files. There is no build step: copy the workspace to a host with Node >= 22.19, install dependencies, and run `fastagent start`.

For deployments, put sessions on durable storage:

```bash
FASTAGENT_SESSIONS_DIR=/data/sessions fastagent start
# or
fastagent start --sessions-dir /data/sessions
```

## 7. Add channels

Add a first-party channel:

```bash
fastagent add github
fastagent add telegram
```

Then run locally with a public tunnel for webhook testing:

```bash
fastagent dev --tunnel
```

Read [Channels](channels.md) for the channel model, [GitHub channel](github.md) for GitHub webhooks, and [Telegram channel](telegram.md) for Telegram bots.

## 8. Run on a clock

Channels react to requests; **schedules** fire the agent on a cron — a daily digest, a periodic check.
Drop a file in `schedules/` (mirroring `tools/`), named by its filename:

```ts
// schedules/daily-digest.ts
import { defineSchedule } from "@kid7st/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt: "Summarize yesterday's activity and send it to the team Telegram.",
});
```

The prompt must say where output goes — the scheduler only fires the agent; delivery is a send tool's
job. `fastagent add telegram` scaffolds one (`tools/telegram-send.ts` sends a message or a file); and
because a scheduled turn runs outside any chat, the agent has no chat context — **put the target chat
id in the prompt** ("…send it to Telegram chat -100123456"). Test it immediately (without waiting for
the cron, and without touching the real fire state):

```bash
fastagent fire daily-digest
```

The cron fires while `dev`/`start` is serving; `fastagent schedule history <name>` answers "did last
night's run silently fail?", and `fastagent schedule list` shows everything that will fire. Agents can
also schedule **themselves** (a built-in `wake` tool — "check the deploy in 10 minutes") — opt in with
`selfSchedule: true` in `fastagent.config.*`. See the [CLI reference](cli.md) and
[API reference](api-reference.md#schedule-authoring).

## Where next

- [Embedding](embedding.md) — use FastAgent as a library inside your own app.
- [Channels](channels.md) — webhook and bot adapters.
- [Deploy](deploy.md) — ship the directory to Fly, Railway, or any Docker host.
- [Agent Handler SPEC](SPEC.md) — the event stream contract.
- [Core design](design/core.md) — maintainer architecture notes.
