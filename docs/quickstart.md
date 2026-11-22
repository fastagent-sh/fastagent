---
title: Quickstart
description: "Five minutes from an installed CLI to a running agent: create it, send it a message, add a tool and serve it."
status: current
---

# Quickstart

You need Node ≥ 24.15 and the CLI: `npm i -g @fastagent-sh/fastagent`.

The agent depends on its own version of FastAgent, and a `fastagent` installed globally runs that version inside it.
Without a global install, the agent's scripts (`npm run dev`, `npm run build`, `npm start`) and
`npx @fastagent-sh/fastagent <command>` run it too. Never `npx fastagent`: that name on npm is another package.

## 1. Create an agent

```bash
fastagent init my-agent
cd my-agent
```

You get `SYSTEM.md` (the prompt), an example skill, `fastagent.config.ts` and `package.json`.

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

## 5. Serve it for real

```bash
fastagent build && fastagent start
```

`start` serves the build without watching files. To put it on a host, see [Deploy](deploy.md).

## Next

[Agent development guide](ai-start.md) · [Embedding](embedding.md) · [Deploy](deploy.md)
