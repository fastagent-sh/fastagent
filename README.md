<p align="center">
  <a href="https://fastagent.sh"><img src="https://raw.githubusercontent.com/fastagent-sh/fastagent/main/assets/hero.png" alt="FastAgent — Vibe first. Then FastAgent. Turn a local agent directory into a durable service in your app or behind the Agent API." width="860"></a>
</p>

[![CI](https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml/badge.svg)](https://github.com/fastagent-sh/fastagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@fastagent-sh/fastagent.svg)](https://www.npmjs.com/package/@fastagent-sh/fastagent)
[![license](https://img.shields.io/npm/l/@fastagent-sh/fastagent.svg)](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@fastagent-sh/fastagent.svg)](https://nodejs.org)
[![built with pi](https://img.shields.io/badge/built%20with-pi-0b7285.svg)](https://pi.dev)
[![GitHub stars](https://img.shields.io/github/stars/fastagent-sh/fastagent?style=social)](https://github.com/fastagent-sh/fastagent/stargazers)
[![follow @kid7st](https://img.shields.io/badge/follow-%40kid7st-000?logo=x)](https://x.com/kid7st)

<p align="center">
  <sub>Built on</sub>
  <a href="https://pi.dev"><img src="https://pi.dev/logo-auto.svg" alt="pi" height="22" /></a>
  <sub>— the agent harness &amp; multi-provider LLM API under the hood</sub>
</p>

FastAgent serves an agent directory (`SYSTEM.md`, `skills/`, TypeScript tools) as a live service: inside your app
or over HTTP through its Agent API, and no message is lost across a restart. You keep the files you have.
There is no new framework to learn.

<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/fastagent-sh/fastagent@main/assets/demo.svg" alt="FastAgent workflow: author an agent directory, serve it locally with fastagent dev, invoke it over the Agent API, and prepare a portable container with fastagent deploy init." width="860">
</p>

## Get started

With a coding agent (Claude Code, Codex, Cursor, …), paste:

> Read https://fastagent.sh/start.md and build an agent in this project.

By hand (Node ≥ 24.15):

```bash
npm i -g @fastagent-sh/fastagent
fastagent init my-agent && cd my-agent
fastagent dev                 # serve locally, reloading on edits
fastagent invoke "hello"      # send it one message
```

The agent depends on its own version of FastAgent, and a `fastagent` installed globally runs that version inside it.
Without a global install, the agent's scripts (`npm run dev`, `npm run build`, `npm start`) and
`npx @fastagent-sh/fastagent <command>` run it too. Never `npx fastagent`: that name on npm is another package.

Then prepare it for Docker, Compose, Fly.io, Railway, or AWS AgentCore (`fastagent deploy init <target>`). The [quickstart](https://fastagent.sh/docs/quickstart/) walks through it.

## Embed it in your app

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import support from "@acme/support-agent"; // a package `fastagent build` made

const agent = await openAgent(support, {
  root: "/var/lib/myapp/support",
  env: baseEnv(process.env),
  model: "openai/gpt-5.5",
});
const session = await agent.sessions.create();
for await (const event of agent.messages.stream({ sessionId: session.id, content: "hi" })) {
  if (event.type === "delta" && event.channel === "text") render(event.text);
}
```

Your app keeps its auth, database and routes. See [Embedding](https://fastagent.sh/docs/embedding/).

## Packages

| Package | Role |
|---|---|
| [`@fastagent-sh/fastagent`](https://www.npmjs.com/package/@fastagent-sh/fastagent) | The durable runtime, Agent API server, `openAgent` embedding, and the `fastagent` CLI |
| [`@fastagent-sh/client`](https://github.com/fastagent-sh/fastagent/blob/main/packages/client/README.md) | The Agent API client: `connectAgent` (HTTP, zero Node deps) and `@fastagent-sh/client/agentcore` |
| [`@fastagent-sh/agentcore`](https://github.com/fastagent-sh/fastagent/blob/main/packages/agentcore/README.md) | Amazon Bedrock AgentCore runtime, Aurora DSQL, Secrets Manager, and CDK construct |
| [`@fastagent-sh/harness-dsh`](https://github.com/fastagent-sh/fastagent/blob/main/packages/harness-dsh/README.md) | Experimental DeepSeek Harness (`@deepseek-ai/dsh`) adapter with OS sandboxing (`--harness dsh`) |

## Documentation

Everything is at **[fastagent.sh/docs](https://fastagent.sh/docs/)**. Start with the
[agent development guide](https://fastagent.sh/docs/ai-start/).

## Status

Pre-1.0. The [Agent API](https://fastagent.sh/docs/agent-api/) is the stable center; the rest of the package may still
change. Changes are in the [releases](https://github.com/fastagent-sh/fastagent/releases).

> ☁️ **Prefer these managed?** FastAgent Cloud will run your agents with multi-instance durability, scale-to-zero, and
> observability built in, and self-hosting stays free. [Join the waitlist →](https://tally.so/r/44DVMB)

## Project

[Contributing](https://github.com/fastagent-sh/fastagent/blob/main/CONTRIBUTING.md) · [Security policy](https://github.com/fastagent-sh/fastagent/blob/main/SECURITY.md) · [MIT license](https://github.com/fastagent-sh/fastagent/blob/main/LICENSE)

Built on **[pi](https://github.com/earendil-works/pi)** (pi-durable's durable agent loop, pi-ai's model API), with
[Effect](https://github.com/Effect-TS/effect), [undici](https://github.com/nodejs/undici),
[chokidar](https://github.com/paulmillr/chokidar), [node-postgres](https://node-postgres.com),
[@clack/prompts](https://github.com/bombshell-dev/clack) and [ignore](https://github.com/kaelzhang/node-ignore). The scaffolded `writing-great-skills` skill is vendored from
[mattpocock/skills](https://github.com/mattpocock/skills), with its license.

If FastAgent saves you from rewriting an agent into another framework, [give it a ⭐](https://github.com/fastagent-sh/fastagent).
