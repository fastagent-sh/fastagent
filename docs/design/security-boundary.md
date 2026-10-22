---
title: Security boundary
description: "Why FastAgent authenticates nothing, what an anonymous caller of a serve can do, the two browser-facing rules (the JSON body gate and CORS), and how a multi-tenant facade in front of one deployment stays safe."
type: design-doc
status: current
---

# Security boundary

> This is the boundary the code serves today. The decided one, which replaces it when the move lands
> ([#788](https://github.com/fastagent-sh/fastagent/issues/788)), authenticates every request with a key and
> authorizes every operation by its principal: [agent-api.md](agent-api.md) §8 and [architecture.md](architecture.md)
> §4.4.

FastAgent authenticates no caller, on any plane. Authentication belongs to the deployment: an API gateway, an
IdP-backed proxy, a private network, AgentCore's IAM, or an embedder's own middleware in front of the Fetch handler.
The planes and their routes are [agent service](agent-service.md) §7.7; this note is what that choice obliges.

## 1. Why nothing is authenticated here

A scheme the framework owns is one it owns badly. Considered, and once shipped: a bearer token the serve mints at boot.

- It is deployment-wide and all-or-nothing, so it expresses no policy a real deployment needs (per user, per
  session, observe versus write).
- It is enforced per route, by hand. A rule each new route must remember is one some route will forget, and the
  failure is silent.
- At the one boundary that matters, a public URL guarded by a secret every caller holds is a public URL.

A channel is the exception that proves the rule: it verifies its platform's signature itself, with the credential
the platform issued (§3).

## 2. What an anonymous caller can do

Whoever reaches the port can do everything it serves:

| Served | What an anonymous caller gets |
|---|---|
| `POST /invoke` (user plane, `http.api`, on by default) | A run with this agent's full tool authority, on any session, billed to the model account |
| `/sessions/*` (user plane) | Every conversation, a channel's direct messages included: list, read, follow, attachments, and abort, rewind, compact or cancel their runs |
| `/agent/*` (user plane) | The agent's info, models and commands |
| `/control/*` (control plane, `http.control`, off by default) | Rename, reconfigure or irreversibly delete any session |
| `GET /health` | Liveness |

`describeAnonymousSurface` (`service.ts`) is the one wording of this list. The startup report (`announceControl`,
`cli/serve.ts`) prints it from what mounted, and `deploy`'s pre-flight from what will mount, so turning a plane off
removes it from both.

- `dev` binds loopback; `start` binds all interfaces, which a container needs, and says so at startup. `--tunnel`
  publishes the whole port. `deploy` warns on every deployment with a public URL.
- **AgentCore has two doors.** The forwarder's Function URL is `AuthType: NONE`, since a platform's webhook cannot
  sign with SigV4, and it relays any path while attaching the ingress secret itself. So it reaches the channels'
  routes only, which verify their callers. The Runtime's own `InvokeAgentRuntime` is IAM-gated, and both planes
  travel through it as `api` envelopes: IAM is that host's gateway (`channels/agentcore.ts`). `http.api`,
  `http.control` and `http.cors` have no effect there, and the container says so at boot.

## 3. A browser is a caller like any other

Origin is not access control. What makes an API safe to call cross-origin is a credential the page does not have,
and there is none here, so the only thing separating the legitimate caller from any page the user visited is network
position: the ambient authority the same-origin policy protects. Two mechanisms follow, one of them policy.

**1. A route that authenticates nobody refuses a body that is not JSON** (`channels/body.ts`, applied by the router
over the whole unverified surface). A POST carrying `text/plain`, `multipart/form-data` or
`application/x-www-form-urlencoded` is a CORS simple request: sent with no preflight, whatever the server would
answer, so withholding response headers only stops the page from reading a run that already started and was billed.
Requiring `application/json` makes the browser preflight it, and a preflight that is not answered is a request never
sent. It is asked of the route, never of whether the request has a body: a body-less POST walks through otherwise.

**2. CORS, and the default is `*`** (`channels/router.ts`). Who may reach this port is the deployment's decision, by
the same rule as §1; deciding it from what this process can observe (which address it bound) would not be that rule.
A wildcard bind is what a container needs and a loopback one is `dev`'s default, and neither is something the
operator said.

- **Know what `*` grants.** Any page the user's browser visits can call the port and read the reply, so a `dev` serve
  left running is drivable by any page you visit: a loopback bind stops another machine, not a page in your own
  browser. The startup report says so at every boot, loopback included.
- **`http.cors` is the only way to narrow it**, and it replaces the default: `["https://app.example.com"]` answers
  that origin and no other, your own loopback page included. `*` cannot be combined with cookie credentials (browsers
  refuse), so a gateway doing cookie auth needs the exact origin.
- **An origin `http.cors` does not list is not answered**: no headers, no refusal. Refusing would mean policing
  same-origin writes too (a browser sends `Origin` on those), which buys nothing mechanism 1 does not cover.
- **A channel's routes are exempt from both**, because the channel verifies its platform's signature itself: a
  Telegram webhook is public on purpose, and Slack posts urlencoded. For a custom channel that is an assumption
  about its author, not a property the router can enforce: verifying its caller is the channel's half of this
  boundary, and a channel that verifies nothing is as reachable from a page as `POST /invoke` would be without
  mechanism 1.
- **The router, not the handlers.** Only the router can answer an `OPTIONS` preflight for a route registered under
  `POST` alone, sees the 404 and 405 it writes itself, and covers a route added later.

A client that is not a browser sends no `Origin`, so mechanism 2 never applies to it; mechanism 1 still does, since
it is about the route. `connectAgent` takes `fetchFn`: wrap `fetch` there to add, refresh or sign whatever the thing
in front of the serve demands.

Neither covers one thing: a cross-origin `GET` of a follow stream is a simple request, so it is sent and the server
subscribes, though the page cannot read a byte of it. That costs a held connection, not a disclosure.

**Known gap, decided not to close (#573): DNS rebinding.** A page that rebinds its own hostname to `127.0.0.1` makes
its requests same-origin: no `Origin` to judge, and any content type, which defeats mechanism 1 and a pinned
`http.cors` alike. With `*` as the default, rebinding is not needed to reach a loopback serve at all; what it still
buys is getting past the JSON gate and a pinned list. Closing it means checking `Host`, and a loopback-only `Host`
rule cannot be unconditional: `cloudflared`, Caddy and Traefik forward the original `Host`, so a same-host facade
would meet a 403 unless a host allowlist ships with it. A `dev` serve that matters is stopped, or put behind
something that authenticates.

## 4. A multi-tenant facade

N users behind one deployment, each reaching only their own sessions: the facade authenticates its user, reads the
session id from the request, checks it against its own user-to-session mapping, and forwards. It never parses an
operation's meaning, and gains no new capability when the protocol does. What makes the pass-through safe:

- **Every route that acts on one session names it in its path**, one percent-encoded segment, so the facade routes
  on a prefix. It compares the DECODED segment against its mapping: `%61bc` and `abc` are one session, and a Feishu
  id containing `/` never matches raw.
- **Following is per session**, never a global stream, so a user cannot watch another's run by holding a connection.
- **A busy session is busy alone** ([SPEC](../SPEC.md) §3.2), so one user's queue answers only to that user.
- **Extracting an id is not authorizing it.** Nothing inside holds a per-session permission to half-configure; the
  facade holds all of it.

**The trap: three routes name their session in the body, or span all of them.**

| Route | Also needs checking |
|---|---|
| `POST /invoke` | `sessionId` in the body; without one, the service creates a session the facade must record as the user's |
| `POST /sessions` | `sessionId` (the new session) and `fork.sessionId` (the history it copies) |
| `GET /sessions` | Never exposed: it lists every session on the deployment; the facade already holds each user's list |

A facade that authorizes only what it finds in a path lets a user read any conversation by naming it as a fork's
source. `POST /invoke` is the easiest to miss and the one that writes.

`GET /agent`, `/agent/models` and `/agent/commands` carry no user data and pass through. The deployment's own port
must not be reachable by end users: nothing behind the facade authenticates, so a user who reaches past it holds
every session. A same-host facade wants `--bind 127.0.0.1`, with two consequences: the API and the channels' webhooks
share one server and one bind, so loopback takes Telegram, Feishu and Slack ingress off the network too; and
`--tunnel` is allowed with that bind (cloudflared dials `localhost`) but republishes the port on a public URL, which
is what the loopback bind was for.

A remotely exposed control plane needs a host that enforces an authenticated principal and per-session
authorization, separate observe and write permissions, an allowed model and thinking-level policy, prompt and
attachment size limits, and an audit record of accepted operations. Nothing in the process is a sandbox: the coding
tools act with the process's authority ([core design](core.md#5-tools-skills-and-execution-environment) §5).
