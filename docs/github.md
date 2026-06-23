---
title: GitHub channel
type: doc
status: current
---

# GitHub channel

Turn an agent into a GitHub webhook responder: a verified delivery routes to an agent turn, and the
agent acts back through `gh` (agent-native — the channel holds no outbound credentials). The channel
is the **N axis** (ingress); how it's served is the **K axis** (host).

## Declare it (the common path)

A deployment's HTTP surface is declared in `fastagent.config.ts` via `channels: (agent) => Routes` —
no hand-written server. `fastagent start` / `fastagent dev` serve it.

```ts
import { defineConfig } from "@kid7st/fastagent";
import { githubChannel } from "@kid7st/fastagent/github";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  channels: (agent) => {
    const webhook = githubChannel(agent, {
      secret: process.env.GITHUB_WEBHOOK_SECRET ?? "", // throws at startup if unset/empty
      on(delivery, run) {
        if (delivery.event === "pull_request" && delivery.action === "opened") {
          run({ session: `pr-${delivery.repo}#${delivery.number}`, text: `Review #${delivery.number}` });
        }
      },
    });
    return { "POST /webhook": webhook, "GET /health": () => new Response("ok") };
  },
});
```

You write **only** the routing `on(delivery, run)`. Everything correctness-critical is internal and
unreachable: HMAC verification, `ping`/unhandled deliveries → 2xx, a body-size cap (413),
`application/json` **and** `application/x-www-form-urlencoded` bodies, ACK-early (the 202 returns
before any turn work — even an async `on`), per-session concurrency, and post-ACK execution + drain.

Point the GitHub webhook's URL at `…/webhook` and set its secret to `GITHUB_WEBHOOK_SECRET`. With no
`channels` field, a deployment serves the default invoke channel at `POST /invoke`.

### `run({ session, text, concurrency? })`

`concurrency` is per call, because one channel routes many event types with different needs — map
your trigger type to a mode (both gate the session to ≤1 in-flight turn, so the engine lease is never
hit):

| mode | trigger type | behavior |
|---|---|---|
| `"coalesce"` (default) | state-latest (PR push → review latest) | deliveries during a run collapse into one re-run of the **latest** |
| `"serialize"` | event-stream (comment commands) | per-session FIFO, one at a time, none dropped |

Independent triggers (each delivery its own task) need no mode — give them **distinct sessions**.
At-most-once (dedup by `deliveryId`) is an orthogonal concern, not a concurrency mode.

`GithubDelivery` pre-extracts the common fields (`event`, `action`, `repo`, `number`, `sender`,
`installationId`) and carries the full typed `payload` (the `@octokit/webhooks-types` union — narrow
it, e.g. `if ("pull_request" in delivery.payload)`).

## Serving (the K axis)

The channel handler returns `{ response, background? }`: the 202 to send now, plus any post-ACK turn
work the host must keep alive. The host satisfies it with its platform's mechanism.

- **Long-running host (Node / fly.io)** — `fastagent start` uses the bundled Node host (`serveNode`),
  which runs the handler, keeps `background` alive in-process, and drains in-flight turns on SIGTERM.
- **Serverless (Cloudflare / Vercel)** — mount the handler yourself and pin `background` with the
  platform's `waitUntil`:

  ```ts
  export default {
    fetch: async (req, env, ctx) => {
      const { response, background } = await channel(req);
      if (background) ctx.waitUntil(background);
      return response;
    },
  };
  ```

  The channel uses only Web-standard APIs (Web Crypto for verification, `@octokit/webhooks-methods`),
  so it loads on Fetch-only runtimes without Node compatibility.

## Deliberate divergence from `@octokit/webhooks`

The channel reuses GitHub's official types (`@octokit/webhooks-types`) and verification
(`@octokit/webhooks-methods`), but **not** the `Webhooks` dispatch/middleware: that awaits handlers
before responding — the opposite of ACK-early. It also accepts `application/x-www-form-urlencoded`
(GitHub's webhook-UI default), which `@octokit/webhooks` does not; the channel owns the raw read, so
the raw-body-preservation hazard that motivates octokit's "JSON only" stance doesn't apply.

## Known gap

A turn that fails **after** the 202 currently only surfaces in server logs. The trigger (e.g. the PR
author) sees nothing and can't retry, because the channel has no way to report back. Surfacing turn
status (a credential resolver / status API) is a later option.
