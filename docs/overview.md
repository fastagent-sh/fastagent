---
title: Overview
description: "What FastAgent is: a serving layer that turns an agent directory into a live service, and what it deliberately leaves to you."
status: current
---

# Overview

FastAgent turns an agent directory into a live service: inside your app, as a chat bot, on a schedule, or behind your
own channel. You keep writing the agent as files. FastAgent runs it.

## An agent is a directory

```txt
reviewer/
├── fastagent.config.ts   # marks the directory as an agent: defineAgent({ defaults, providers })
├── SYSTEM.md             # the system prompt
├── AGENTS.md             # optional: how this agent is built and changed
├── skills/  prompts/     # optional: skills, and prompt templates run as /<name>
├── src/tools/            # optional: tools
├── src/channels/         # optional: Telegram, Slack, Feishu or your own
├── src/schedules/        # optional: prompts run on a cron
├── context.json          # what it works on (GitHub repositories) and the commands it needs
└── fastagent.json        # optional: this instance's settings (a deployment gets its own)
```

`fastagent init` creates it as a git repository. The projects it works on stay outside it, declared as its
[content](configuration.md#content). The agent can edit its own prompt and skills; a change applies from its next
message.

## The few ideas you need

| Idea | Meaning |
|---|---|
| **Session** | One conversation. It lives in the instance's storage and survives restarts. |
| **Message** | What you send into a session. Once accepted, it is answered, even after a restart. |
| **Tool** | A typed action the model can call. Its arguments are checked before it runs. |
| **Skill** | Markdown know-how the agent loads when it needs it. |
| **Channel** | Turns a platform's events into messages, after checking they really come from that platform. |
| **Instance** | One running copy of the agent, with its own storage, secrets and settings. |

Everything (a channel, a schedule, `fastagent invoke`, your app, a program over HTTP) talks to the agent through one
interface, the [Agent API](agent-api.md).

## What FastAgent leaves to you

| It does not… | Because |
|---|---|
| host you on a platform or dashboard | it runs locally, inside your app, or in a container on any host |
| invent a format | it reads `AGENTS.md`, Agent Skills and TypeScript modules |
| run workflows | the agent decides its own steps; drive fixed sequences from your own queue |
| manage users | one key guards a whole instance; give each customer an instance ([security model](agent-api.md#security)) |
| tie you to a model or cloud | any provider pi-ai supports, or your own; any host that runs a container |

## Not built yet

- One instance spread over several processes (one process owns an instance's storage today).
- A sandbox around the agent process: its tools act with the process's authority.
- Telemetry export (OpenTelemetry).
