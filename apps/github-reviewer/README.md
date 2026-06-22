# github-reviewer

A fastagent agent that reviews GitHub pull requests. It is the N×M×K vertical slice over the
fastagent core:

| Axis | Here |
|---|---|
| **N** (trigger) | a GitHub **webhook** → `createWebhookHandler` + `src/github-binding.ts` |
| **M** (agent) | `AGENTS.md` + the `review-checklist` skill, served on pi; it posts the review with `gh` |
| **K** (host) | **fly.io** (a long-running container) + `createTrackedBackground` for the post-ACK review |

The agent is a *fat* agent: on a PR event it uses `gh` (via its `bash` tool) to read the diff and
post a review. The webhook ACKs `202` immediately and runs the review in the background.

## Layout

```
AGENTS.md                     # the reviewer persona + process
skills/review-checklist/      # what to look for + the exact gh recipes
src/github-binding.ts         # WebhookBinding: verify signature, classify (invoke/ignore/reject), map to a per-PR session
src/server.ts                 # composition root: artifact agent + webhook channel + background runner
fastagent.config.mjs          # model
Dockerfile / fly.toml         # K = fly.io
```

## Secrets

Set as fly secrets (`fly secrets set NAME=…`); locally put them in `.env`:

| Secret | What |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | the secret you set on the GitHub webhook; the binding verifies HMAC with it |
| `GH_TOKEN` | a token the **agent** uses (`gh`) to read the PR and post the review (needs `repo` / PR review scope) |
| model auth | the model in `fastagent.config.mjs`. **OAuth (default `openai-codex`)**: set `PI_AUTH_JSON="$(cat ~/.pi/agent/auth.json)"` — `server.ts` writes it to `~/.pi/agent/auth.json` at boot so pi's OAuth resolver finds it (no refresh yet, so a long run needs the secret re-set). **Or API-key**: set `FASTAGENT_MODEL=<provider/id>` + the provider key (e.g. `OPENAI_API_KEY`). |

`GITHUB_TOKEN` (for installing the private `@kid7st/fastagent` at build) is a **build** secret, not
a runtime one — passed via `--build-secret` (see below).

## Deploy

```bash
fly launch --no-deploy            # create the app (keep this fly.toml)
fly volumes create reviewer_data --size 1   # for /data/sessions
fly secrets set GITHUB_WEBHOOK_SECRET=… GH_TOKEN=… FASTAGENT_MODEL=… OPENAI_API_KEY=…
fly deploy --build-secret GITHUB_TOKEN=$(gh auth token)   # or: npm run deploy
```

Then add a webhook on the target repo (Settings → Webhooks):

- **Payload URL**: `https://<app>.fly.dev/webhook`
- **Content type**: `application/json`
- **Secret**: the same `GITHUB_WEBHOOK_SECRET`
- **Events**: *Pull requests* only

Open or push to a PR → GitHub POSTs the event → the reviewer ACKs `202`, reviews in the
background, and posts its review. Non-PR deliveries (ping, labels, comments) are ACKed `200` and
ignored.

## Local check

```bash
export GITHUB_TOKEN=$(gh auth token)   # to install the package
npm ci
fastagent dev                          # assemble + serve the SSE channel (sanity-check the agent)
fastagent chat                         # or try it interactively
```

(The webhook server itself — `src/server.ts` — runs against a built artifact: `fastagent build`
then `node src/server.ts`, with the secrets above set.)
