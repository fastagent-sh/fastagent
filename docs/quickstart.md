---
title: Quickstart
description: "Five minutes from an installed CLI to a running agent: create it, send it a message, add a tool, a channel and a schedule."
status: current
---

# Quickstart

You need Node ≥ 24.15 (or Bun ≥ 1.4) and the CLI: `npm i -g @fastagent-sh/fastagent`.

## 1. Create an agent

```bash
fastagent init my-agent
cd my-agent
```

You get `SYSTEM.md` (the prompt), an example skill, `fastagent.config.ts` and `package.json`. To have the agent work on
a project, add `--content ~/code/app` (or later `fastagent content add ~/code/app`).

## 2. Send it a message

```bash
fastagent invoke "Summarize SYSTEM.md in one sentence"
```

The first run asks you to pick a model and sign in, and prints the line to keep in `fastagent.config.ts`. Without a
terminal, pass `--model provider/model-id`. `fastagent models` lists the choices.

## 3. Run it

```bash
fastagent dev
```

Prompt and skill edits apply on the next message; code edits restart it. Conversations survive restarts.

## 4. Add a tool

```ts
// src/tools/reverse.ts
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";

export default defineTool({
  name: "reverse",
  description: "Reverse a string.",
  parameters: obj({ text: str() }),
  execute: async ({ text }) => ({ output: [{ type: "text", text: [...text].reverse().join("") }] }),
});
```

```bash
fastagent invoke "Reverse the word hello with the reverse tool"
```

Mention the tool in `SYSTEM.md` so the model knows when to use it. A tool that needs a secret declares it with
[`needs`](configuration.md#secrets-in-code).

## 5. Add a channel

```bash
fastagent add telegram    # or slack, feishu, lark
fastagent dev             # asks for the bot's credentials the first time
```

No tunnel needed: Telegram is polled, Slack and Feishu hold a connection. See [Channels](channels.md).

## 6. Run it on a clock

```ts
// src/schedules/daily-digest.ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt: "Summarize yesterday's activity and send it with telegram_send to chat 123456789.",
});
```

A schedule only sends the agent a message, so name where the answer goes (a send tool and a chat id) in the prompt.
Try it now with `fastagent schedules run daily-digest`. See [Schedules](configuration.md#schedules).

## 7. Serve it for real

```bash
fastagent build && fastagent start
```

`start` serves the build without watching files. To put it on a host, see [Deploy](deploy.md).

## Next

[Agent development guide](ai-start.md) · [Embedding](embedding.md) · [Deploy](deploy.md)
