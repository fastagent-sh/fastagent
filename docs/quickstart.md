---
title: Quickstart
type: doc
status: current
---

# Quickstart

From an installed CLI to a running, deployable agent in a few minutes. Everything here runs locally.

## Prerequisites

- **Node ≥ 22.19** (`node -v`). The package ships compiled JavaScript; consuming projects do not need a build step for FastAgent itself.
- **The `fastagent` CLI** — see [Install](../README.md#install): `npm i -g @kid7st/fastagent`, with the `@kid7st` scope registry + a GitHub token in your `~/.npmrc`.
- **Model credentials** — either `fastagent login` (OAuth) or a provider API key in the workspace's `.env` (e.g. `OPENAI_API_KEY=…`). Run `fastagent models` to list the available `provider/modelId` specs.

## 1. Scaffold an agent

```bash
fastagent init my-agent
cd my-agent
```

`init` writes a complete agent (instructions **+ a tool**) and runs `npm install`:

```
my-agent/
├── AGENTS.md                    # the agent's instructions (its system prompt)
├── skills/house-style/SKILL.md  # an on-demand skill
├── tools/word-count.ts          # a code tool (defineTool) — auto-discovered
├── fastagent.config.mjs         # deployment choices: model, http port
├── package.json                 # ESM + the @kid7st/fastagent + zod deps
├── .env.example                 # optional env knobs (model/keys/port) — copy to .env
└── .gitignore / .npmrc
```

For a pure prompt+skills agent with no code and no dependencies, use `fastagent init my-agent --minimal`.

## 2. Run it

```bash
fastagent dev
```

The startup report shows the model, auth source, loaded skills, and tools, and then watches for changes — a save **restarts the worker** (the `fastagent dev` command itself stays up; `--no-watch` to disable). If it prints `auth: (none found)`, set credentials (see prerequisites) and re-run. Then send a turn:

```bash
curl -N -X POST localhost:8787/invoke \
  -H 'content-type: application/json' \
  -d '{"session":"s1","text":"How many words are in: the quick brown fox jumps"}'
```

The response is a stream of Server-Sent Events — `text` deltas, `tool_started` / `tool_ended` when the model calls a tool, and a terminal `completed`. The scaffolded agent calls its `word-count` tool here:

```
data: {"type":"tool_started","name":"word-count","args":{"text":"the quick brown fox jumps"}}
data: {"type":"tool_ended","isError":false,"content":{"details":{"words":5,"characters":25}}}
data: {"type":"completed"}
```

Reuse the same `session` value to continue a conversation; conversations persist under `.fastagent/sessions`, so a `dev` restart keeps them.

To try the agent interactively instead of over HTTP, run `fastagent chat`. It opens the **same** assembled agent (same model, tools, skills, instructions) in pi's full interactive TUI — streaming, tool rendering, `/` commands, model switching, session resume — so you can vibe-check what you'll serve without writing a client.

## 3. Add a tool

A tool is a file in `tools/`; the **filename is the tool name**, and `tools/` is auto-discovered — no registration in the config. Drop in `tools/reverse.ts`:

```ts
import { defineTool, z } from "@kid7st/fastagent";

export default defineTool({
  description: "Reverse a string.",
  input: z.object({ text: z.string() }),
  async execute({ text }) {
    return { reversed: [...text].reverse().join("") };
  },
});
```

Test it directly — no model, no server, no tokens:

```bash
fastagent tool reverse '{"text":"hello"}'
# → { "reversed": "olleh" }
```

`fastagent dev` **reloads on save** — it restarts the worker on any edit to `AGENTS.md` / skills / tools / config, so the served agent is always your latest code (including modules a tool imports). A broken edit stops the worker with the error printed and waits for the next save; the `dev` command never crashes. Mention the tool in `AGENTS.md` so the model knows when to use it. (`input` is a [Zod](https://zod.dev) schema: the args are validated before `execute`, and an invalid call is reported back to the model, not a crash.)

## 4. Build and run the artifact

```bash
fastagent build                  # → .fastagent/build : a self-contained, relocatable artifact
fastagent start .fastagent/build # run it in production posture
```

`build` compiles the workspace (instructions + skills + tools + config) into an artifact whose manifest freezes the model and http port. `start` runs that artifact with sessions kept **outside** it (so a redeploy never wipes conversations). To deploy: copy the artifact directory anywhere with Node ≥ 22.19, run `npm ci`, then `fastagent start`.

## Where next

- [SPEC](SPEC.md) — the Agent Handler contract (`invoke(scope, prompt) => AsyncIterable<AgentEvent>`) the whole thing rests on.
- [core-design](core-design.md) — the pi reference implementation, the N × M × K layering, and the build/start deployment model.
