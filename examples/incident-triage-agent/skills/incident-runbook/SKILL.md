---
name: incident-runbook
description: Structured incident triage format for production alerts, latency spikes, and 5xx errors.
---

Produce a triage brief with four sections:

1. **Severity & Blast Radius:** `SEV-1` (full outage / data loss), `SEV-2` (major degradation), or `SEV-3` (minor / isolated), plus affected endpoints or users.
2. **Verified Evidence:** Live probe results (`probe_endpoint`), HTTP status/latency, and recent commits (`recent_commits`) or MCP telemetry.
3. **Likely Root Cause:** Ranked hypotheses with confidence (`high` / `medium` / `low`) and what would confirm or rule out each.
4. **Immediate Next Steps:** Concrete diagnostic queries, rollback candidate commit SHA, and a 2-sentence status-page draft.
