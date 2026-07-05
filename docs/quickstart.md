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

The default scaffold is complete: instructions, one skill, one code tool, config, package metadata, and `.env.example`.

```txt
my-agent/
├── AGENTS.md
├── skills/house-style/SKILL.md
├── tools/word-count.ts
├── fastagent.config.mjs
├── package.json
├── .env.example
└── .gitignore
```

For a markdown-only workspace with no code tools or dependencies:

```bash
fastagent init my-agent --minimal
```

## 2. Inspect it

```bash
fastagent info
```

`info` is read-only. It prints the model, loaded `AGENTS.md`, skills, discovered tools, channels, diagnostics, and session path without starting a server.

If no model is set, choose one of:

```bash
fastagent dev --model provider/model-id
FASTAGENT_MODEL=provider/model-id fastagent dev
# or edit fastagent.config.mjs
```

## 3. Run locally

```bash
fastagent dev
```

`dev` assembles the workspace and serves it on `:8787`. AGENTS.md/`skills/` edits go live on the next turn; code edits (`tools/`, `channels/`, config) restart the worker. The default channel is `POST /invoke`.

Send one turn:

```bash
curl -N -X POST localhost:8787/invoke \
  -H 'content-type: application/json' \
  -d '{"session":"s1","text":"How many words are in: the quick brown fox jumps"}'
```

The response is Server-Sent Events. Events include `text`, optional `thinking`, tool events, and exactly one terminal `completed` or `failed`.

```txt
data: {"type":"tool_started","id":"tool-1","name":"word-count","args":{"text":"the quick brown fox jumps"}}

data: {"type":"tool_ended","id":"tool-1","isError":false,"content":{"details":{"words":5,"characters":25}}}

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
fastagent invoke "Summarize AGENTS.md in one sentence"
```

Run one tool without a model:

```bash
fastagent tool word-count '{"text":"hello from fastagent"}'
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

Mention the tool in `AGENTS.md` so the model knows when to use it. `fastagent dev` reloads on save.

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

## Where next

- [Embedding](embedding.md) — use FastAgent as a library inside your own app.
- [Channels](channels.md) — webhook and bot adapters.
- [Agent Handler SPEC](SPEC.md) — the event stream contract.
- [Core design](design/core.md) — maintainer architecture notes.
