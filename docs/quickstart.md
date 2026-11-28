---
title: Quickstart
description: "Go from zero to a working, durable FastAgent service with a typed TypeScript tool in five minutes."
status: current
---

# Quickstart

In five minutes you will create an agent, add a typed TypeScript tool, run it locally with live reload, and serve a production build over the Agent API.

**Prerequisite:** Node ≥ 22.18 (Node 24/26 LTS recommended) or Bun ≥ 1.4.4.

```bash
npm i -g @fastagent-sh/fastagent
```

> Inside an agent directory, the global `fastagent` binary automatically runs that agent's installed version. Prefer not to install globally? Use `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is an unrelated package) or the project's `npm run dev` / `build` / `start` scripts.

## 1. Create or initialize your agent

```bash
fastagent init my-agent          # new agent directory
cd my-agent
```

Already have `SYSTEM.md` or `skills/` in the current directory, or adding an agent inside an existing application?

```bash
fastagent init                   # initialize or resume in the current directory (preserves existing files)
fastagent init agents/support    # add an agent in a child directory of an existing app
```

For a fresh directory, `init` creates a git repository with a starter prompt (`SYSTEM.md`), an example skill (`skills/writing-great-skills/`), configuration (`fastagent.config.ts`), `package.json`, and `.gitignore` (keeping `.secrets/` and `.fastagent/` out of version control). For an existing agent directory, it preserves your files, adds missing setup, and verifies dependencies—run `fastagent info --json` to confirm your skills are detected.

## 2. Send your first message

```bash
fastagent invoke "Summarize SYSTEM.md in one sentence"
```

On the first run in a terminal, FastAgent walks you through choosing a model and signing in, then prints the `model` line to save in `fastagent.config.ts`. Running without a terminal? Pass `--model provider/model-id`. Use `fastagent models` to browse available models.

## 3. Add a typed TypeScript tool

Create `src/tools/reverse.ts`. FastAgent loads every file in `src/tools/` automatically—no manual registration required. `defineTool` works on both `pi-durable` and `dsh` harnesses and accepts plain JSON Schema (`as const`) or Zod v4 (or any Standard JSON Schema v1 library):

```ts
// src/tools/reverse.ts
import { defineTool } from "@fastagent-sh/fastagent";

export default defineTool({
  name: "reverse",
  description: "Reverse a string.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to reverse" },
    },
    required: ["text"],
  } as const,
  execute: async ({ text }) => [...text].reverse().join(""),
});
```

Call it right away:

```bash
fastagent invoke "Reverse the word hello with the reverse tool"
```

Mention custom tools in `SYSTEM.md` so the model knows when to use them. If a tool needs an API key or config value, declare it with [`needs()`](configuration.md#declare-secrets-in-code).

## 4. Run locally with live reload

```bash
fastagent dev
```

`dev` serves your agent locally at `http://127.0.0.1:8787`:
- Edits to `SYSTEM.md`, `AGENTS.md`, `skills/`, and `prompts/` apply on the next message—no restart.
- Edits to `src/`, `fastagent.config.ts`, `package.json`, or `.secrets/.env` restart cleanly once active turns finish.
- Conversations persist across every restart.

In a second terminal, `fastagent invoke` connects automatically to the running `dev` server so both share the same sessions. Set `FASTAGENT_API_KEY` in `.secrets/.env` to also call it over HTTP (`POST /v1/invoke`, `/v1/sessions`, or `connectAgent()` from `@fastagent-sh/client`).

## 5. Build and run for production

```bash
fastagent build
fastagent start
```

`fastagent build` type-checks and compiles your agent into `dist/`. `fastagent start` serves that compiled build in production posture (no file watching, structured `info` logs).

Need kernel-enforced OS sandboxing around built-in coding tools (`read`, `write`, `edit`, `bash`)? Install `@fastagent-sh/harness-dsh` and run with `--harness dsh`:

```bash
npm i @fastagent-sh/harness-dsh
fastagent dev --harness dsh
```

## Where to go next

- **Build a real agent step by step (or let your coding agent build it):** [Agent development guide](ai-start.md)
- **Understand how FastAgent works under the hood:** [Technical architecture](architecture.md)
- **Call your agent from code or HTTP:** [Agent API](agent-api.md) · [Embedding](embedding.md)
- **Ship to production:** [Deploy](deploy.md)
- **Operate deployed agents remotely:** [Remotes & clients](remotes.md)
