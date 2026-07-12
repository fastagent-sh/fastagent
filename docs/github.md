---
title: GitHub channel
description: "Connect GitHub webhooks to your agent: setup, signature verification, mapping events to agent turns, and operational notes for PR review bots."
status: current
---

# GitHub channel

The GitHub channel turns a verified webhook delivery into one or more agent turns.

It is an ingress adapter only: it verifies and routes GitHub events, then starts agent turns. If the agent should comment, label, review, or call GitHub APIs, give the agent tools or environment credentials to do that work.

## Add the channel

From an agent workspace:

```bash
fastagent add github
```

This creates `channels/github.ts` and appends the required env var to `.env.example` when possible.

```ts
import { githubChannel } from "@fastagent-sh/fastagent/github";

export default githubChannel({
  secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  on: (event) => {
    if (event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload) {
      const { repository, pull_request } = event.payload;
      return [
        {
          session: event.deliveryId,
          text: `Review PR #${pull_request.number} in ${repository.full_name}`,
        },
      ];
    }
    return [];
  },
});
```

`fastagent dev` and `fastagent start` discover `channels/*.ts` automatically. You do not add a config entry.

## Configure GitHub

1. Get a webhook secret. `fastagent add github` already generated one and wrote it to the run-root
   `.env` when `.env` is gitignored; otherwise set one yourself:

   ```bash
   GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 24)   # then put it in .env
   ```

2. In GitHub, create a repository webhook:
   - Payload URL: `https://<host>/webhook`
   - Content type: `application/json`
   - Secret: the value of `GITHUB_WEBHOOK_SECRET`
   - Events: choose the events your `on()` handler routes.
3. The webhook's Secret and the `.env` value must match — copy it from `.env`.

For local testing, run:

```bash
fastagent dev --tunnel
```

FastAgent starts a Cloudflare quick tunnel if `cloudflared` is installed and prints the webhook URL to paste into GitHub.

## Routing model

`on(event) => Intent[]` is the only policy you write.

```ts
type GithubEvent = {
  event: string;       // X-GitHub-Event
  action?: string;     // payload.action when present
  deliveryId: string;  // X-GitHub-Delivery
  payload: Schema;     // @octokit/webhooks-types union
};

type Intent = {
  session: string;
  text: string;
};
```

Return:

- `[]` to ignore the delivery,
- one intent for one turn,
- multiple intents for fan-out.

Choose session IDs deliberately. Independent work should use distinct sessions. Repeated events for the same subject can share a session, but concurrent same-session turns fail fast with `session busy` because the engine enforces one writer per session.

## HTTP behavior

The adapter handles:

- HMAC verification (`x-hub-signature-256`),
- a 25 MiB raw-body cap,
- `application/json`,
- GitHub's `application/x-www-form-urlencoded` webhook UI default,
- `ping` deliveries,
- ignored deliveries as successful acknowledgements.

For accepted work, the channel returns `202` and runs turns after the ACK.

## Limitations

Post-ACK turns run in the current Node process. If the process exits, in-flight GitHub turns are lost and only the server log remains. Durable intent storage and retry are future host/adapter work.

Do not use this channel in a serverless function that freezes or terminates immediately after returning the HTTP response.
