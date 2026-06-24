---
title: GitHub channel
type: doc
status: current
---

# GitHub channel

Turn an agent into a GitHub webhook responder: a verified delivery routes to one or more agent turns,
and the agent acts back through `gh` (agent-native — the channel holds no outbound credentials). The
channel is the **N axis** (ingress); how it's served is the **K axis** (host).

## Declare it

A deployment's HTTP surface is declared in `fastagent.config.ts` via `channels: (agent) => Routes` —
no hand-written server. `fastagent start` / `fastagent dev` serve it.

```ts
import { defineConfig } from "@kid7st/fastagent";
import { githubChannel } from "@kid7st/fastagent/github";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  channels: (agent) => ({
    "POST /webhook": githubChannel(agent, {
      secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
      // Key the session on the PR's identity (repo#number), not the per-delivery id, so a PR's pushes
      // share a session and the engine's per-session lease serializes them.
      on: (event) => {
        if (event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload) {
          const { repository, pull_request } = event.payload;
          return [{ session: `pr-${repository.full_name}#${pull_request.number}`, text: `Review #${pull_request.number}` }];
        }
        return [];
      },
    }),
    "GET /health": () => new Response("ok"),
  }),
});
```

You write **only** the routing `on(event) => Intent[]`. Everything else is internal: HMAC
verification, a body-size cap (413), `application/json` **and** `application/x-www-form-urlencoded`
bodies (GitHub's webhook-UI default), and `ping`/unhandled deliveries → 2xx. Point the GitHub
webhook's URL at `…/webhook` and set its secret to `GITHUB_WEBHOOK_SECRET`.

### `GithubEvent` and `Intent`

`on` receives a `GithubEvent` and returns `Intent[]`:

- `GithubEvent` = `{ event, action?, deliveryId, payload }`. `event` is the `X-GitHub-Event` header,
  `deliveryId` the `X-GitHub-Delivery` header, `action` is `payload.action` (the usual discriminant).
  `payload` is the full event, typed via `@octokit/webhooks-types` (the official source) — narrow it
  for event-specific fields, e.g. `if ("pull_request" in event.payload)`.
- `Intent` = `{ session, text }` — a session id and the prompt text for an agent turn. Return one per
  delivery you act on (or several for fan-out), `[]` to ignore.

## Execution model

The endpoint **ACKs 202 immediately** and runs each turn **fire-and-forget** on the long-running
process — the event loop keeps it alive to completion. There are no concurrency modes: same-session
concurrency is bounded by the engine's per-session **lease** (a second concurrent same-session turn
fails fast). For independent work, give each delivery a **distinct session**.

## Serving (the K axis)

The channel is a plain Fetch handler (`(Request) => Response`). On a long-running host (Node / fly.io)
`fastagent start` serves it via the bundled Node host (`serveNode` + `router`). The channel reads only
Web-standard + `@octokit/webhooks-*` APIs, so it *loads* on Fetch-only runtimes — but its fire-and-forget
turns need a process that stays alive, so **serverless is not supported** until durable execution exists.

## Deliberate divergence from `@octokit/webhooks`

The channel reuses GitHub's official types (`@octokit/webhooks-types`) and verification
(`@octokit/webhooks-methods`), but **not** the `Webhooks` dispatch/middleware (it awaits handlers
before responding — the opposite of ACK-early). It also accepts `application/x-www-form-urlencoded`,
which `@octokit/webhooks` does not; the channel owns the raw read, so the raw-body hazard behind
octokit's "JSON only" stance doesn't apply.

## Known gaps

- A turn that fails **after** the 202 only reaches server logs; the trigger (e.g. the PR author) sees
  nothing and can't retry.
- **In-flight turns are lost on shutdown / redeploy.** A short platform grace (e.g. fly.io's default
  5 s) can't drain a minute-long agent turn anyway, so the channel doesn't try.

The real fix for both is **durable execution** (persist the intent, run it in a worker, retry across
deploys) — deferred until there's a consumer.
