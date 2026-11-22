# Deep Research & Daily Brief Agent

A long-running research agent that queries live Hacker News discussions and GitHub releases, writes cited Markdown reports to the workspace, and runs on a schedule over scale-to-zero `POST /v1/invoke`:

- **Real external data, zero extra SDKs:** `search_hacker_news` (public Algolia HN API) and `github_releases` (GitHub REST API with optional `GITHUB_TOKEN` via `needs()`).
- **Prompt templates + skills:** Run `/daily-brief` (`prompts/daily-brief.md`) to trigger the full multi-step research workflow formatted by `skills/synthesis-report/SKILL.md`.
- **Crash-resilient & steerable:** Long research runs survive restarts; attach live from your terminal with [`@fastagent-sh/pi-remote`](../../packages/pi-remote/README.md) (`/fa`) to watch tool progress or steer the investigation mid-run.

## Run locally

```bash
npm install
npx @fastagent-sh/fastagent invoke "/daily-brief"
```

## Trigger from a cron job (scale-to-zero friendly)

```bash
# Terminal 1: serve the Agent API
FASTAGENT_API_KEY=dev-secret npm run dev

# Terminal 2: trigger today's idempotent brief
FASTAGENT_API_KEY=dev-secret node cron-trigger.ts
```

## Watch or steer live from Pi

```bash
fastagent remote add research https://<your-host> --key '$RESEARCH_AGENT_KEY'
pi -e npm:@fastagent-sh/pi-remote --fa research
```
