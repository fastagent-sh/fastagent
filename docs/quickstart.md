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

Model credentials come in step 2, after the agent exists. `fastagent models` lists model specs.

## 1. Create an agent

```bash
fastagent init my-agent
cd my-agent
```

The agent lands in `fastagent/`; the directory around it is its **workspace**: its working directory, and where
its `AGENTS.md` is read from. The agent can edit its own definition; `persona.md` and skills are re-read every turn.

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

`persona.md` tells the agent to capture improvements as skills, and `writing-great-skills` (from
[mattpocock/skills](https://github.com/mattpocock/skills)) shows how. No `AGENTS.md` is scaffolded; the workspace's
own is read as project context. Add skills with `fastagent add skill <owner/repo/path>`; delete
`tools/fetch-url.ts` if you do not want it.

## 2. Inspect it

```bash
fastagent info
```

`info` is read-only. It prints the model, persona, context files (`AGENTS.md`), skills, discovered tools, channels, diagnostics, and session path without starting a server.

**In an existing project**, run `fastagent init .`: the agent goes into `./fastagent/` with no writes elsewhere, and
the project becomes its workspace. `--agent-dir bot` picks another directory name; a `fastagent.config.ts` is what
makes a directory an agent.

A fresh agent presets no model. The first `fastagent dev` (or `start` / `invoke`) in a terminal shows the model
catalog, providers with credentials first; picking one that needs auth runs the login, and the pick is written to
`fastagent.config.ts`. Credentials are stored in `<agent dir>/.secrets/auth.json`, with
`~/.fastagent/.secrets/auth.json` (`fastagent login -g`) as a fallback. To set the model without a prompt (CI,
deploy):

```bash
fastagent dev --model provider/model-id
FASTAGENT_MODEL=provider/model-id fastagent dev
# or edit fastagent.config.ts
```

## 3. Run locally

```bash
fastagent dev
```

`dev` serves the agent on `:8787`. Edits to `persona.md`, `AGENTS.md` and `skills/` apply on the next turn; code
edits (`tools/`, `channels/`, config) restart the worker. Turns run through `POST /invoke`.

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

`start` serves like `dev` without watching files. There is no build step: copy the agent to a host with
Node >= 22.19, install dependencies, and run `fastagent start`.

For deployments, point the state root (sessions and channel state) and the secrets dir (`.env` and `auth.json`) at
durable storage:

```bash
FASTAGENT_STATE_DIR=/data/.state FASTAGENT_SECRETS_DIR=/data/.secrets fastagent start
```

## 7. Add channels

Add a first-party channel:

```bash
fastagent add telegram
fastagent add slack
fastagent add feishu     # 飞书 (open.feishu.cn)
fastagent add lark       # Lark international
```

Then run locally with a public tunnel for webhook testing:

```bash
fastagent dev --tunnel
```

Read [Channels](channels.md) for the channel model, [Telegram channel](telegram.md) for Telegram bots, [Slack channel](slack.md) for Slack apps, and [Feishu channel (Lark compatibility)](feishu.md) for Feishu and Lark bots.

## 8. Run on a clock

Channels turn external events into invocations; **schedules** do the same for the clock — firing the
agent on a cron: a daily digest, a periodic check. Drop a file in `routines/` (mirroring `tools/`), named by its filename:

```ts
// routines/daily-digest.ts
import { defineRoutine } from "@fastagent-sh/fastagent";

export default defineRoutine({
  cron: "0 9 * * *",
  tz: "America/New_York",
  secrets: ["TEAM_CHAT_ID"],
  prompt: (secrets) => `Summarize yesterday's activity and send it with telegram-send to chat ${secrets.TEAM_CHAT_ID}.`,
});
```

The scheduler only fires the agent; a send tool delivers the output (`fastagent add telegram` scaffolds
`tools/telegram-send.ts`). A scheduled turn has no chat, so **the prompt must name the target chat id**. Declare the
id in `secrets` and build the prompt from it: `dev`/`start` refuse to boot while it is unset. Set `TEAM_CHAT_ID` in
`.secrets/.env`, then test without waiting for the cron (the real fire state is not touched):

```bash
fastagent routine run daily-digest
```

On resident hosts, the cron fires while `dev`/`start` is serving; keep the process running.
[AgentCore ingress](deploy.md#aws-bedrock-agentcore) instead uses EventBridge and supports scale-to-zero.
`fastagent routine history <name>` answers "did last night's run silently fail?", and
`fastagent routine list` shows the selected local state's pending work. Agents can
also schedule **themselves** with the built-in `wake` tool ("check the deploy in 10 minutes"), mounted on every
serve. See the [CLI reference](cli.md) and
[API reference](api-reference.md#routine-authoring).

## Where next

- [Agent development guide](ai-start.md) — responsibilities, TypeScript, verification, and host-specific operation.
- [Embedding](embedding.md) — use FastAgent as a library inside your own app.
- [Channels](channels.md) — webhook and bot adapters.
- [Deploy](deploy.md) — ship the directory to Fly, Railway, AWS Bedrock AgentCore, or any Docker host.
- [Agent Handler SPEC](SPEC.md) — the event stream contract.
- [Core design](design/core.md) — maintainer architecture notes.
