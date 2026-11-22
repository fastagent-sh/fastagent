# Scale-to-Zero AI SRE Incident Triage Agent

An on-call triage agent built for webhook-driven alerting (Sentry, Datadog, PagerDuty) on scale-to-zero infrastructure:

- **Alert-storm safe:** `webhook-trigger.ts` calls `POST /v1/invoke` with `conversation: "incident:<id>"`, `idempotencyKey: "<alert-event-id>"`, and `whenBusy: "steer"` so duplicate webhooks never re-run and follow-up signals steer an active investigation.
- **Hardened against untrusted alert payloads:** `codingTools: false` disables built-in shell/file access; the agent only runs explicit typed tools (`probe_endpoint`, `recent_commits`) and optional `mcpServers`.
- **Zero idle cost:** Deploy to Fly.io (`fastagent deploy init fly`) or Railway; `POST /v1/invoke` wakes the container on alert and lets it suspend once triage settles.

## Run locally

```bash
npm install
FASTAGENT_API_KEY=dev-secret npm run dev
```

In a second terminal, simulate an incoming alert webhook:

```bash
FASTAGENT_API_KEY=dev-secret node webhook-trigger.ts
```

## Deploy with OpenTelemetry traces

```bash
npx @fastagent-sh/fastagent deploy init fly
npx @fastagent-sh/fastagent deploy check
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the host to export tool latency, token usage, and GenAI spans without capturing sensitive log payloads.
