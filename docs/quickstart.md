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

`my-agent/` is the agent: its definition, and its working directory. The agent can edit its own definition;
`APPEND_SYSTEM.md` and skills are re-read every turn.

```txt
my-agent/
├── APPEND_SYSTEM.md               # standing instructions — how to improve yourself
├── skills/writing-great-skills/   # the example skill: how to author skills well
├── extensions/web-access.ts       # web search and page fetching (@fastagent-sh/pi-web-access)
├── fastagent.config.ts            # model, contexts, http
├── package.json
├── .secrets/.env.example          # secrets live here, never committed
└── .gitignore
```

`APPEND_SYSTEM.md` tells the agent to capture improvements as skills, and `writing-great-skills` (from
[mattpocock/skills](https://github.com/mattpocock/skills)) shows how. Add skills with
`fastagent add skill <owner/repo/path>`.

`extensions/web-access.ts` gives the agent `web_search`, `fetch_content` (readable pages, PDFs, GitHub repositories),
`get_search_content` and `source_check`, from `@fastagent-sh/pi-web-access`: fastagent's build of the pi package
[pi-web-access](https://pi.dev/packages/pi-web-access) that keeps each conversation's results its own when the agent
serves several at once ([fork](https://github.com/fastagent-sh/pi-web-access); the fix is proposed upstream). Where the
model can add tools mid-conversation, a session starts with `web_enable` only, and the model calls it to make the
others available, so a turn's first web tool event is often `web_enable`. It needs no key: searches go to Exa, or to
OpenAI's search when you sign in with a ChatGPT subscription. Fetches of private and reserved addresses are blocked by
default. For more providers, put their keys (`BRAVE_API_KEY`, `EXA_API_KEY`, `GEMINI_API_KEY`, … see the package
README) in `.secrets/.env`, which travels with a deploy; `~/.pi/agent/web-search.json` on the serving machine works
too, but stays on that machine. The file loads the package's tools only: its terminal commands (`/websearch`,
`/curator`, `/google-account`, `/search`) open a browser on the serving machine or rewrite its config, so they are not
offered to callers. To go without it, delete the file and `npm uninstall @fastagent-sh/pi-web-access`.

**To have it work on a project**, declare the project as a context: `fastagent init my-agent --context ~/code/app`,
or later `fastagent context add ~/code/app`. The agent stays in its own directory and is told where the project is;
the project's `AGENTS.md` and its skills load with the agent. A context it should only read is added with
`--readonly`. See [contexts](configuration.md#contexts).

## 2. Inspect it

```bash
fastagent info
```

`info` is read-only. It prints the contexts, model, prompt, skills, discovered tools, channels, diagnostics, and
session path without starting a server.

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

`dev` serves the agent on `:8787`. Edits to `SYSTEM.md`, `APPEND_SYSTEM.md`, the agent's own or a context's `AGENTS.md` and `skills/` apply on the next turn; code
edits (`tools/`, `channels/`, config) restart the worker. Turns run through `POST /invoke`.

Send one turn:

```bash
curl -N -X POST localhost:8787/invoke \
  -H 'content-type: application/json' \
  -d '{"session":"s1","text":"Summarize https://example.com in two bullets"}'
```

The response is Server-Sent Events. Events include `text`, optional `thinking`, tool events, and exactly one terminal `completed` or `failed`.

```txt
data: {"type":"tool_started","id":"tool-1","name":"fetch_content","args":{"url":"https://example.com"}}

data: {"type":"tool_ended","id":"tool-1","isError":false,"content":{"content":[{"type":"text","text":"# Example Domain …"}]}}

data: {"type":"completed"}
```

Reuse the same `session` value to continue a conversation. Local sessions persist under `<state root>/sessions` (default `.state/sessions` in the agent directory), so a dev restart keeps conversation history.

## 4. Try authoring loops

Open the same assembled agent in pi's interactive TUI:

```bash
fastagent chat
```

Run one agent turn without a server:

```bash
fastagent invoke "Summarize APPEND_SYSTEM.md in one sentence"
```

## 5. Add a tool

Tools are modules in `tools/`. A tool that declares no `name` takes its file's name.

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

Mention the tool in `APPEND_SYSTEM.md` so the model knows when to use it. `fastagent dev` reloads on save.

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
agent on a cron: a daily digest, a periodic check. Drop a Markdown file in `schedules/`, named by its filename: the
cron in the frontmatter, the prompt under it.

```md
<!-- schedules/daily-digest.md -->
---
cron: "0 9 * * *"
tz: America/New_York
---

Summarize yesterday's activity and send it with telegram-send to chat 123456789.
```

The scheduler only fires the agent; a send tool delivers the output (`fastagent add telegram` scaffolds
`tools/telegram-send.ts`). A scheduled turn has no chat, so **the prompt must name the target chat id**. Every fire
continues one conversation, `schedule:daily-digest`, so the agent sees what its earlier runs did.

On resident hosts, the cron fires while `dev`/`start` is serving; keep the process running.
[AgentCore ingress](deploy.md#aws-bedrock-agentcore) instead uses EventBridge and supports scale-to-zero.
`fastagent schedules list` shows when each schedule runs next and how its last run ended. To try the prompt now,
`fastagent invoke` it. Agents can also schedule **themselves** with the built-in `wake` tool ("check the deploy in
10 minutes"), mounted on every serve. See [Schedules](configuration.md#schedules).

## Where next

- [Agent development guide](ai-start.md) — responsibilities, TypeScript, verification, and host-specific operation.
- [Embedding](embedding.md) — use FastAgent as a library inside your own app.
- [Channels](channels.md) — webhook and bot adapters.
- [Deploy](deploy.md) — ship the directory to Fly, Railway, AWS Bedrock AgentCore, or any Docker host.
- [Agent Handler SPEC](SPEC.md) — the event stream contract.
- [Core design](design/core.md) — maintainer architecture notes.
