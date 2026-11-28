# FastAgent Examples

Four production-grade examples demonstrating FastAgent's three core strengths: one Agent API everywhere, durable & isolated execution, and embedding or deploying to any cloud platform (requires Node ≥ 22.18 or Bun ≥ 1.4.4).

| Example | Use case | Key FastAgent features |
| --- | --- | --- |
| [`pr-review-agent`](./pr-review-agent/) | Background PR code review triggered from GitHub Actions | `dsh` `read-only` OS sandbox, `defineTool`, `needs()`, `POST /v1/invoke` with per-PR `conversation` & `Idempotency-Key` |
| [`incident-triage-agent`](./incident-triage-agent/) | Scale-to-zero AI SRE for on-call alert triage & root-cause analysis | `@fastagent-sh/client`, alert-storm deduplication, `whenBusy: "steer"`, SSRF-guarded probe tool, `mcpServers`, Fly.io scale-to-zero |
| [`saas-copilot`](./saas-copilot/) | Multi-tenant B2B SaaS copilot embedded in a Hono backend | `openAgent()`, `openPostgresDatabase()` shared pool, `codingTools: false` isolation, `sessionIdOf()`, resumable SSE (`after` cursor) |
| [`deep-research-agent`](./deep-research-agent/) | Long-running technical research & scheduled daily brief | Real HN & GitHub Release tools, `/daily-brief` prompt template, durable crash recovery, external Cron `POST /v1/invoke` |
