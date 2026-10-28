---
title: Security boundary
description: "Why FastAgent serves no API and authenticates no caller of its own, what a serve does expose (routes that verify their caller), and why an instance is one trust domain, so people who must be kept apart get an instance each."
type: design-doc
status: current
---

# Security boundary

An instance is one trust domain. Whoever holds its Agent can do everything the agent can: every session, and
everything its tools reach ([Agent API](../SPEC.md) §8). So FastAgent puts the Agent API on no network
([architecture.md](architecture.md) §2, [Agent API](../SPEC.md) §10). A serve answers only routes that verify their
caller, and everyone they let in is inside the trust domain.

## 1. Why FastAgent authenticates no caller of its own

A scheme the framework owns is one it owns badly. One was considered, and once shipped: a bearer token the serve
mints at boot.

- It is deployment-wide and all-or-nothing, so it expresses no policy a real deployment needs (per user, per session,
  observe versus write).
- It is enforced per route, by hand. A rule each new route must remember is one some route will forget, and the
  failure is silent.
- At the one boundary that matters, a public URL guarded by a secret every caller holds is a public URL.

What does authenticate a caller is whoever already knows who it is: a chat platform, which signs what it delivers,
and a host's own identity system (AgentCore's IAM).

## 2. What a serve exposes

| Route | Who can call it |
|---|---|
| A channel's routes (`POST /telegram`, `/slack`, `/feishu`, …) | The platform, proven by its own credential: Telegram's secret token, Slack's `v0` HMAC over the body with a five-minute window, Feishu's verification token and, with an Encrypt Key, its signature. Each comparison is constant-time (`channels/secret.ts`) |
| `GET /health` | Anyone; it answers liveness and nothing else |
| AgentCore's `POST /invocations` and `GET /ping` | Two doors. The forwarder's Function URL is `AuthType: NONE`, since a platform's webhook cannot sign with SigV4; it relays any path and attaches the ingress secret, which the container checks, so it reaches only the channels' routes, which verify their callers. The Runtime's own `InvokeAgentRuntime` is IAM-gated, and the only envelope it accepts is `probe`, which answers whether the definition opened (`channels/agentcore.ts`) |

- **A custom channel MUST verify its caller.** The router cannot check that a route verifies anything: verifying is
  the channel's half of this boundary, and a channel that verifies nothing gives anyone who finds its URL a message
  into the agent.
- **A platform's signature proves the platform, not the person.** Everyone who can message a channel's bot is inside
  the trust domain, and can ask the agent for anything its tools reach, every other chat's conversation included.
  Who may message the bot is decided on the platform (who is in the workspace, who can find the bot).
- **Where the port is reachable is the deployment's choice.** `dev` binds loopback; `start` binds all interfaces, which
  a container needs; `--tunnel` publishes the port on a public URL.

There is no JSON body gate and no CORS policy: they guarded routes that verified nothing, and no route is like that
now. A page in a browser cannot forge a platform's signature, and cannot read what a webhook answers.

## 3. People who must be kept apart

The agent's tools reach every session of their instance, whichever session asked: `read` and `bash` reach the
instance's storage under the state root (`agent.sqlite`) and every channel's files. A session id is a name, not a
credential. So a check on session ids does not keep users apart, and FastAgent does not offer one.

- **Give each customer an instance of its own**, with its own storage and its own channels. That is the boundary the
  code keeps.
- An app that embeds the agent and serves it to its own users writes its own routes over the Agent API, behind its own
  authentication. It can keep its users apart by session only for an agent whose tools reach neither the instance's
  storage nor its files, and it must check every session id a request names: the one a message is sent to, and the
  source of a fork (`sessions.create({ forkFrom })`), which is how a user would read a session that is not theirs.

Nothing in the process is a sandbox: the coding tools act with the process's authority
([core design](core.md#5-tools-skills-and-execution-environment)).
