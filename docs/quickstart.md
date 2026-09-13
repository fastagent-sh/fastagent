---
title: Quickstart
description: "From an installed CLI to a live local agent service: scaffold an agent, run it, add a typed tool, connect channels, and put the agent on a clock."
status: current
---

# Quickstart

This guide takes you from an installed CLI to a live local agent service.

## Prerequisites

- Node >= 22.19 (`node --version`).
- FastAgent CLI: `npm i -g @fastagent-sh/fastagent`.

Model credentials come in step 2 — after the agent exists, because `fastagent login` stores them
**per project**.

List available model specs with:

```bash
fastagent models
```

## 1. Create an agent

```bash
fastagent init my-agent
cd my-agent
```

The default scaffold is a **self-iterating agent** — it is files, and it can edit its own definition (persona.md and skills are re-read every turn). The agent lands in `fastagent/`; the directory around it is its WORKSPACE — what it works on, and where its `AGENTS.md` is read from:

```txt
my-agent/                              # the workspace — the agent's cwd, untouched by init
└── fastagent/                         # the agent
    ├── persona.md                     # its identity — how to improve yourself
    ├── skills/writing-great-skills/   # the example skill: how to author skills well
    ├── tools/fetch-url.ts             # an example code tool
    ├── fastagent.config.ts
    ├── package.json
    ├── .secrets/.env.example          # secrets live here, never committed
    └── .gitignore
```

`persona.md` teaches the agent to capture durable improvements as new skills; `writing-great-skills` (vendored from [mattpocock/skills](https://github.com/mattpocock/skills)) is the guide it consults to write them. No `AGENTS.md` is scaffolded — that file is *project context* the agent reads (yours, or a host repo's), not its identity. Add more skills with `fastagent add skill <owner/repo/path>`. Don't want the code tool? Delete `tools/fetch-url.ts` — the scaffold is one shape, and everything in it is yours after `init`.

## 2. Inspect it

```bash
fastagent info
```

`info` is read-only. It prints the model, persona, context files (`AGENTS.md`), skills, discovered tools, channels, diagnostics, and session path without starting a server.

**Initializing inside an existing project?** Same command, same result: `init` puts the WHOLE agent into `./fastagent/` — zero writes elsewhere, so the project's build and the agent's surface never sweep each other, and the repo's own `AGENTS.md` is read as project context. A `fastagent.config.ts` file identifies the agent; `fastagent/` is only the default directory name.

**The repository IS the agent?** (A standalone agent repo, or a monorepo package.) Run `fastagent init` in it: that repository becomes the WORKSPACE and the definition lands in `./fastagent/`, which is also the shape `fastagent deploy` needs. **Want a different directory name?** `fastagent init . --agent-dir bot` — the `fastagent.config.ts` inside is what makes a directory an agent, never its name.

A fresh agent presets no model. On the first `fastagent dev` (or `start` / `invoke`) in a
terminal, FastAgent shows the full model catalog — models whose provider already has credentials (a
stored login, or a provider API key in your env/`.env`) come first, annotated with the source; picking
one that needs auth runs the login flow right there — and writes your pick back to
`fastagent.config.ts`. Credentials are stored per project (`<agent dir>/.secrets/auth.json`, no global
fallback), so a login from another directory is invisible here. To set the model non-interactively
(or in CI/deploy, where there is no prompt):

```bash
fastagent dev --model provider/model-id
FASTAGENT_MODEL=provider/model-id fastagent dev
# or edit fastagent.config.ts
```

## 3. Run locally

```bash
fastagent dev
```

`dev` assembles the agent and serves it on `:8787`. persona.md/AGENTS.md/`skills/` edits go live on the next turn; code edits (`tools/`, `channels/`, config) restart the worker. The default channel is `POST /invoke`.

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

Reuse the same `session` value to continue a conversation. Local sessions persist under `<state root>/sessions` (default `fastagent/.state/sessions`), so a dev restart keeps conversation history.

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
import { defineTool, z } from "@fastagent-sh/fastagent";

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

`start` uses the same assembly as `dev`, but does not watch files. There is no build step: copy the agent to a host with Node >= 22.19, install dependencies, and run `fastagent start`.

For deployments, point both machinery roots at durable storage: the state root (sessions **and** channel state — Telegram's durable turn replay lives there too) and the secrets dir (the agent's `.env` and the `auth.json` an OAuth refresh rotates on the box):

```bash
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

(`FASTAGENT_SESSIONS_DIR` / `--sessions-dir` override just the sessions path; they do not move channel state, and neither knob moves `auth.json`.)

## 7. Add channels

Add a first-party channel:

```bash
fastagent add github
fastagent add telegram
fastagent add slack
fastagent add feishu     # 飞书 (open.feishu.cn)
fastagent add lark       # Lark international
```

Then run locally with a public tunnel for webhook testing:

```bash
fastagent dev --tunnel
```

Read [Channels](channels.md) for the channel model, [GitHub channel](github.md) for GitHub webhooks, [Telegram channel](telegram.md) for Telegram bots, [Slack channel](slack.md) for Slack apps, and [Feishu channel (Lark compatibility)](feishu.md) for Feishu and Lark bots.

## 8. Run on a clock

Channels turn external events into invocations; **schedules** do the same for the clock — firing the
agent on a cron: a daily digest, a periodic check. Drop a file in `schedules/` (mirroring `tools/`), named by its filename:

```ts
// schedules/daily-digest.ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  secrets: ["TEAM_CHAT_ID"],
  prompt: (secrets) => `Summarize yesterday's activity and send it with telegram-send to chat ${secrets.TEAM_CHAT_ID}.`,
});
```

The prompt must say where output goes — the scheduler only fires the agent; delivery is a send tool's
job. `fastagent add telegram` scaffolds one (`tools/telegram-send.ts` sends a message or a file); and
because a scheduled turn runs outside any chat, the agent has no chat context — **the prompt must name
the target chat id**. That id is environment-specific, so declare it in `secrets` and build the prompt
from it (as above) rather than hardcoding it: same contract as a tool's secrets — `deploy` carries the
value and `dev`/`start` refuse to boot while it is unset. Set `TEAM_CHAT_ID` in `.secrets/.env` first —
the same gate refuses a run while the name is unset. Then test it immediately (without waiting for
the cron, and without touching the real fire state):

```bash
fastagent fire daily-digest
```

On resident hosts, the cron fires while `dev`/`start` is serving; keep the process running.
[AgentCore ingress](deploy.md#aws-bedrock-agentcore) instead uses EventBridge and supports scale-to-zero.
`fastagent schedule history <name>` answers "did last night's run silently fail?", and
`fastagent schedule list` shows the selected local state's pending work. Agents can
also schedule **themselves** (a built-in `wake` tool — "check the deploy in 10 minutes") — opt in with
`selfSchedule: true` in `fastagent.config.ts`. See the [CLI reference](cli.md) and
[API reference](api-reference.md#schedule-authoring).

## Where next

- [Agent development guide](ai-start.md) — responsibilities, TypeScript, verification, and host-specific operation.
- [Embedding](embedding.md) — use FastAgent as a library inside your own app.
- [Channels](channels.md) — webhook and bot adapters.
- [Deploy](deploy.md) — ship the directory to Fly, Railway, AWS Bedrock AgentCore, or any Docker host.
- [Agent Handler SPEC](SPEC.md) — the event stream contract.
- [Core design](design/core.md) — maintainer architecture notes.
