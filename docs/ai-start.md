---
title: Build and Serve an Agent with FastAgent
description: "An executable setup path for coding agents: build and serve a FastAgent agent starting from nothing, from existing files, or inside an existing application."
status: current
---

# Skill: Build and Serve an Agent with FastAgent

Use this skill to build an agent with FastAgent and serve it — starting from nothing, from files that already exist, or inside an existing application.

## Goal

Inspect the project first, preserve anything that already exists, and make the smallest change that gives the user a running agent: locally, embedded in their app, connected to a channel, or deployed.

## Choose your path

Decide which job this is before touching anything:

1. **New agent, empty directory.** Nothing agent-shaped exists yet. Run `fastagent init <dir>` (or init the current directory), then flesh out `persona.md`, skills, and tools from what the user wants.
2. **An existing directory becomes the agent.** The project already has `AGENTS.md`, markdown context, skills, or tools — vibed or handwritten. Do not restructure it: run `fastagent init` in place; init never overwrites existing files and adopts them as the definition.
3. **Embed an agent into an existing application.** The project is an app (framework config, routes, its own toolchain). Initialize — init chooses `./agent` with `config.agentDir` automatically when the root is claimed — then mount the agent in the app's own route with `createPiAgentFromDefinition` + `createInvokeHandler`. The app keeps auth, database, and deployment.

All three paths continue with the same steps below: inspect, authenticate, initialize once, test, then connect channels or deploy.

## Mental model

- The directory is the agent: optional `persona.md` for identity, `skills/`, `tools/`, `channels/`, `schedules/`, markdown context, and `AGENTS.md` for project context.
- An `AGENTS.md` does not make a directory a FastAgent workspace. A `fastagent.config.*` file does.
- FastAgent can run the directory locally, embed it in an app, connect it to GitHub or Telegram, expose it over HTTP, or put it behind a custom channel.
- Do not invent a new project layout unless the user asks. Prefer the existing directory.

## Inspect before changing anything

1. Check whether `fastagent.config.*` exists. If it does, the directory is already a workspace; read its `agentDir` when present.
2. Check for `persona.md`, `AGENTS.md`, `skills/`, `tools/`, `channels/`, and `schedules/` at the root and under any configured `agentDir`.
3. If code tools are present, check whether `package.json` sets `"type": "module"`.
4. Ask before choosing a model provider, adding credentials, or changing the existing layout.

## Handle authentication and models explicitly

You are non-interactive, so do not rely on prompts you cannot answer.

- A model must be explicit. Without one, `dev`, `start`, and `invoke` open an interactive picker and fail in a non-TTY with `missing model`.
- `fastagent login` is also interactive. Ask the user to run it in a terminal inside the workspace; it writes project-level `.fastagent/auth.json`, and credentials written in another directory are not visible here.
- Alternatively, ask the user for a provider API key and put it in `.env` only with permission.
- List available specifications with `fastagent models`.
- Always pass `--model provider/id`, set `FASTAGENT_MODEL`, or write `model` in `fastagent.config.*`.
- Never commit `.env`, credentials, sessions, or `.fastagent/` machine state.

## Know which commands exit

Use commands that exit for verification:

```bash
fastagent info
fastagent models
fastagent invoke "hello" --model provider/id
fastagent tool <name> '<json>'
```

`fastagent dev` and `fastagent start` are long-running servers. Do not run them in the foreground and wait indefinitely. Background them with a cleanup path, or ask the user to run them.

## Initialize once

Run:

```bash
fastagent init <dir>
```

The default directory is the current directory. `init`:

- scaffolds `persona.md`, an example skill and tool, and config;
- never overwrites existing files;
- keeps an existing `AGENTS.md` as project context;
- refuses a directory that already has `fastagent.config.*`.

FastAgent chooses the layout on the first run:

- flat by default;
- `./agent` with `config.agentDir` when an existing toolchain or deployment already claims the root, including framework config, `tsconfig`, `go.mod`, `pyproject.toml`, `Cargo.toml`, Docker/Fly/Railway config, or occupied `tools/`, `channels/`, or `skills/` directories.

Override only on the first run with `--flat` or `--agent-dir <name>`. To change it later, move the files and update or remove `config.agentDir`.

Then run:

```bash
fastagent info
```

Read what the directory assembles into and fix only reported problems.

## Test locally

Prefer a single turn that exits:

```bash
fastagent invoke "hello" --model provider/id
```

Test a tool without a model:

```bash
fastagent tool <name> '<json>'
```

Only start a live server when needed:

```bash
fastagent dev --model provider/id
```

Background it or ask the user to run it, then send a turn to `POST /invoke`.

## Add tools

Put tools in `tools/<name>.ts`. Use `defineTool` and `z` from `@fastagent-sh/fastagent`, then test the tool directly:

```bash
fastagent tool <name> '<json>'
```

## Add channels

A `channels/*.ts`, `*.js`, or `*.mjs` file is enabled by its presence. A declared channel that fails to load must make `dev` or `start` fail; fix it rather than accepting a fallback route.

To disable one, rename it to something like `channels/telegram.ts.disabled`. Do not invent a second config flag.

### GitHub

```bash
fastagent add github
```

Edit `channels/github.ts` so `on(event)` maps real GitHub events to `{ session, text }` intents. Use `fastagent dev --tunnel` for local webhook testing.

### Telegram

```bash
fastagent add telegram
```

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_SECRET_TOKEN`. Use `fastagent dev --tunnel` for local webhook testing.

## Add schedules

Create `schedules/<name>.ts`:

```ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt: "...",
});
```

The filename is the schedule name. The prompt must say where output goes: the scheduler fires the agent, but a plain reply is not delivered anywhere. Delivery is a send tool's job. A scheduled turn runs outside any chat, so include the target chat ID in the prompt.

`fastagent add telegram` scaffolds `tools/telegram-send.ts`, which can send a message or file.

Test without changing cron state:

```bash
fastagent fire <name> --model provider/id
```

Inspect schedules and prior runs:

```bash
fastagent schedule list
fastagent schedule history <name>
```

Cron schedules run only while `dev` or `start` is serving. Agent self-scheduling through the built-in `wake` tool is opt-in with `selfSchedule: true` in config.

Schedules and self-scheduling require one always-running machine. Do not scale that deployment to zero.

## Embed in an application

Use `createPiAgentFromDefinition` or `createPiAgentFromWorkspace`, then mount `createInvokeHandler(agent)` in the application's route.

Keep authentication, users, database, session ownership, and policy in the host application.

`ExecutionEnv` is an assembly seam, not a complete sandbox. The pi coding tools and project-context loader are still local; do not claim that injecting `env` alone isolates a directory agent.

## Deploy

Generate host artifacts and a runbook:

```bash
fastagent deploy docker   # local Compose; add --tunnel for an ephemeral webhook ingress
fastagent deploy fly
fastagent deploy railway
```

Add `--run` to drive Docker Compose or the host CLI to completion.

The model must be in `fastagent.config.*`. A builder-local `--model`, `FASTAGENT_MODEL`, or `.env` value does not reach the deployed machine and otherwise causes a `missing model` crash loop.

Declare additional host secrets in `config.deploy.secrets`, then register channel webhooks at the live URL.

## Verify before finishing

1. Run `fastagent info`.
2. If channels are declared, confirm every channel loads.
3. Run the smallest useful command that exits, usually:

   ```bash
   fastagent invoke "hello" --model provider/id
   ```

4. Do not leave `dev` or `start` running in the foreground.
5. Do not commit `.env`, credentials, sessions, or `.fastagent/` state.
6. If a command fails, read [Troubleshooting](troubleshooting.md) before guessing.

## References

- [Quickstart](quickstart.md)
- [Configuration](configuration.md)
- [Embedding](embedding.md)
- [Channels](channels.md)
- [Deploy](deploy.md)
- [Troubleshooting](troubleshooting.md)
