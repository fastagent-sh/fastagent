# Multi-Tenant Embedded SaaS Copilot (Hono + Shared PostgreSQL Pool)

Embeds FastAgent inside a B2B SaaS backend while keeping your own authentication, tenancy, and routes:

- **Strict tenant isolation:** Each tenant gets its own `openAgent()` instance (`TENANT_ID` injected via `needs()`), with `codingTools: false` so the model can only call your explicit typed tools (`get_workspace_metrics`).
- **One shared PostgreSQL pool:** Set `FASTAGENT_DATABASE_URL` to share a single `openPostgresDatabase()` pool across all tenant instances in one Node process (falls back to per-tenant SQLite locally).
- **Gapless resumable SSE:** `GET /api/sessions/:sessionId/events?after=<entryId>` replays missed entries, delivers the live snapshot, and resumes streaming seamlessly after browser refreshes or drops.

## Run

1. Install and compile the embedded agent:
   ```bash
   npm install
   cd agent && npm install && cd ..
   npm run build:agent
   ```
2. Start the Hono server (add `FASTAGENT_DATABASE_URL=postgres://...` to use PostgreSQL):
   ```bash
   OPENAI_API_KEY=sk-... FASTAGENT_MODEL=openai/gpt-5.5 npm start
   ```
3. Create a tenant session, stream events, and send a message:
   ```bash
   SESSION=$(curl -s -X POST http://127.0.0.1:3000/api/sessions \
     -H "x-tenant-id: acme" | jq -r .id)

   curl -s -X POST "http://127.0.0.1:3000/api/sessions/$SESSION/messages" \
     -H "x-tenant-id: acme" \
     -H "Content-Type: application/json" \
     -d '{"content": "Summarize my workspace usage and plan limits", "wait": 60}' | jq .answer.text
   ```
