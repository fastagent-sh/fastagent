---
title: Quickstart
description: "From an installed CLI to a live local agent service: scaffold an agent, check it, add a typed tool, connect channels, and put the agent on a clock."
status: current
---

# Quickstart

This guide takes you from an installed CLI to a live local agent service.

## Prerequisites

- Node >= 24.15 (`node --version`), or Bun >= 1.4.
- FastAgent CLI: `npm i -g @fastagent-sh/fastagent`.

Model credentials come in step 2, after the agent exists. `fastagent models` lists model specs.

## 1. Create an agent

```bash
fastagent init my-agent
cd my-agent
```

`my-agent/` is the agent: its definition, and its working directory. The agent can edit its own definition;
`SYSTEM.md` and skills are read for every message.

```txt
my-agent/
├── SYSTEM.md                      # the system prompt: who the agent is, what it does, how it improves itself
├── skills/writing-great-skills/   # the example skill: how to author skills well
├── fastagent.config.ts            # model, providers, http
├── package.json                   # FastAgent, pi-durable and pi-ai, installed by init
├── .secrets/.env.example          # secrets live here, never committed
└── .gitignore
```

`SYSTEM.md` tells the agent to capture improvements as skills, and `writing-great-skills` (from
[mattpocock/skills](https://github.com/mattpocock/skills)) shows how. Add skills with
`fastagent add skill <owner/repo/path>`. Code goes under `src/` when you need it: `src/tools/`, `src/channels/`,
`src/schedules/`, `src/extensions/`.

**To have it work on a project**, declare the project as its content: `fastagent init my-agent --content ~/code/app`,
or later `fastagent content add ~/code/app`. The agent stays in its own directory and is told where the project is,
and reads the project's files, its `AGENTS.md` included, when it works there. A GitHub checkout is declared as its
repository in `context.json`, so every instance has it; any other directory is bound in `context.local.json`, on this
machine only. See [content](configuration.md#content).

## 2. Check it

```bash
fastagent info
```

`info` prints what the agent opens as: its content, model, tools, skills and commands, channels, schedules, declared
secrets and paths, without starting a server. `--json` is the form a script or a coding agent reads.

A fresh agent presets no model. The first `fastagent dev` (or `start` / `invoke`) in a terminal shows the model
catalog, providers with credentials first; picking one that needs auth runs the login, and the line to put in
`fastagent.config.ts` is printed. Credentials are stored in `<agent dir>/.secrets/auth.json`, with
`~/.fastagent/.secrets/auth.json` (`fastagent login -g`) as a fallback. To set the model without a prompt (CI,
deploy):

```bash
fastagent dev --model provider/model-id
FASTAGENT_MODEL=provider/model-id fastagent dev
# or set `model` in fastagent.config.ts
```

## 3. Send it a message

```bash
fastagent invoke "Summarize SYSTEM.md in one sentence"
```

`invoke` opens the agent, sends one message in a new session, prints the answer on stdout and each tool call on
stderr, and exits non-zero unless the message completed. It needs no server.

## 4. Run locally

```bash
fastagent dev
```

`dev` serves the agent locally: its channels, schedules and wake-ups. Edits to `SYSTEM.md`, `AGENTS.md`, `skills/` and
`prompts/` apply on the next message; code edits (`src/`, config) restart the worker. The agent is reached through its
channels (step 7) and its schedules (step 8), from an app that embeds it ([Embedding](embedding.md)), and, with
`FASTAGENT_API_KEY` in `.secrets/.env`, over HTTP under `/v1` ([Configuration](configuration.md#the-agent-api-over-http)). Its sessions persist in `<state root>/agent.sqlite` (default `.state/` in the agent
directory), so a restart keeps conversation history.

## 5. Add a tool

Tools are modules in `src/tools/`, each default-exporting pi-durable's `defineTool`:

```ts
// src/tools/reverse.ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export default defineTool({
  name: "reverse",
  description: "Reverse a string.",
  parameters: Type.Object({ text: Type.String() }),
  execute: async ({ text }) => ({ output: [{ type: "text", text: [...text].reverse().join("") }] }),
});
```

Test it in a unit test (call its `execute`), then with the model:

```bash
fastagent invoke "Reverse the word hello with the reverse tool"
```

Mention the tool in `SYSTEM.md` so the model knows when to use it. `fastagent dev` restarts on save. A tool that reads
a secret declares it with `needs` ([secrets in code](configuration.md#secrets-in-code)).

## 6. Serve without watch

```bash
fastagent start
```

`start` serves like `dev` without watching files. There is no build step: copy the agent to a host with
Node >= 24.15, install dependencies, and run `fastagent start`.

For deployments, point the state root (the agent's storage and channel state) and the secrets dir (`.env` and
`auth.json`) at durable storage:

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

Channels turn external events into messages; **schedules** do the same for the clock — a daily digest, a periodic
check. A schedule is a module of `src/schedules/`, named by its file:

```ts
// src/schedules/daily-digest.ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt: "Summarize yesterday's activity and send it with telegram_send to chat 123456789.",
});
```

The scheduler only sends the agent a message; a send tool delivers the output (`fastagent add telegram` scaffolds
`src/tools/telegram-send.ts`). A scheduled message has no chat, so **the prompt must name the target chat id**. Every
fire continues the schedule's own session, so the agent sees what its earlier runs did.

On resident hosts, the cron fires while `dev`/`start` is serving; keep the process running.
[AgentCore](deploy.md#aws-bedrock-agentcore) instead uses EventBridge and supports scale-to-zero.
`fastagent schedules list` shows when each schedule runs next and how its last run ended. To try one now, as its
clock would fire it, `fastagent schedules run <name>`. Agents can also schedule **themselves** with the built-in `wake` tool ("check the deploy in
10 minutes"), on every serve. See [Schedules](configuration.md#schedules).

## Where next

- [Agent development guide](ai-start.md) — responsibilities, TypeScript, verification, and host-specific operation.
- [Embedding](embedding.md) — use FastAgent as a library inside your own app.
- [Channels](channels.md) — webhook and bot adapters.
- [Deploy](deploy.md) — ship the directory to Fly, Railway, AWS Bedrock AgentCore, or any Docker host.
- [Agent API SPEC](SPEC.md) — the API every Caller uses.
- [Core design](design/core.md) — maintainer architecture notes.
