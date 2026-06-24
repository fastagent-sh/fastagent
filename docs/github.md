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
      // Each review is independent + idempotent (it reconciles against the PR's existing comments), so
      // use a distinct per-delivery session — overlapping deliveries all run, none dropped.
      on: (event) => {
        if (event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload) {
          const { repository, pull_request } = event.payload;
          return [{ session: event.deliveryId, text: `Review #${pull_request.number} in ${repository.full_name}` }];
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

The endpoint **ACKs 202** and runs each turn **fire-and-forget** on the long-running process. There
are no concurrency modes: same-session concurrency is the engine's per-session **lease** (a second
concurrent same-session turn fails fast), so give independent work **distinct sessions**. Distinct
sessions run concurrently — if you route recurring same-subject events (e.g. `synchronize`), make the
agent's action idempotent and race-safe (a check-then-act on shared state can double-fire).

Served on a long-running Node host (`fastagent start`). The turns run fire-and-forget on the process,
so **serverless is unsupported** — the channel is Node-only until durable execution lands.

## Known gaps

A turn that fails after the 202, and any in-flight turn on shutdown/redeploy, is lost (server log
only). The real fix is **durable execution** (persist the intent, retry across deploys), deferred.
