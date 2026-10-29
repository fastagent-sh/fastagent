---
title: Security boundary
description: "What a serve exposes (routes that verify their caller, and the Agent API behind the instance's keys), why its one credential of its own is a key for the whole instance, and why an instance is one trust domain, so people who must be kept apart get an instance each."
type: design-doc
status: current
---

# Security boundary

An instance is one trust domain. Whoever holds its Agent can do everything the agent can: every session, and
everything its tools reach ([Agent API](../SPEC.md) §10). A serve answers only routes that verify their caller, and
everyone they let in is inside the trust domain.

## 1. One key for the instance, and no policy of FastAgent's

FastAgent's one credential of its own is the Agent API's key ([Agent API](../SPEC.md) §9.1): a key for the whole
instance, which keeps everyone but the instance's customer out. It expresses no policy (per user, per session, observe
versus write), and does not try to: one instance serves one customer, and people who must be kept apart get an
instance each (§3). An earlier bearer token, minted at boot and checked by each route by hand, was removed for what it
got wrong, and the key is shaped by that:

- It is the deployment's, set in its values (`FASTAGENT_API_KEY`), several at once so one is replaced without a gap;
  not minted where nobody could hand it on.
- It is checked once, by the middleware of the API's one contract (`http/contract.ts`, `http/server.ts`), on every
  route of it: no route can forget it. Without a key, the API is not served at all.
- It is a credential for a server. There is no CORS, so a browser page cannot call the API, and an app that serves
  users from a browser calls it from its backend.

Whoever else calls an agent is authenticated by whoever already knows who it is: a chat platform, which signs what it
delivers, and a host's own identity system (AgentCore's IAM).

## 2. What a serve exposes

| Route | Who can call it |
|---|---|
| A channel's routes (`POST /telegram`, `/slack`, `/feishu`, …) | The platform, proven by its own credential: Telegram's secret token, Slack's `v0` HMAC over the body with a five-minute window, Feishu's verification token and, with an Encrypt Key, its signature. Each comparison is constant-time (`channels/secret.ts`) |
| `GET /health` | Anyone; it answers liveness and nothing else |
| The Agent API under `/v1` | Whoever presents one of the instance's keys (`Authorization: Bearer`), compared in constant time. Not served without a key, and not served on AgentCore |
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
now. A page in a browser cannot forge a platform's signature, cannot read what a webhook answers, and is not let call
the API.

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
