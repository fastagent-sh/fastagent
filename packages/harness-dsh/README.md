# @fastagent-sh/harness-dsh (Experimental)

Optional second harness for [FastAgent](https://fastagent.sh) backed by [DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness).

## Status

**Experimental Phase 1 live runtime (private, not published to npm yet).** Boots Cordis + `AgentLoop`, bridges `@earendil-works/pi-ai` models and FastAgent tools, and passes all 61 conformance tests in `test/harnesses/agent-api-conformance.ts`. See [DESIGN.md](DESIGN.md) for the architecture, empirical `0.2.2-rc.5` spike findings, and Phase 2–3 roadmap.

## Design boundary

- Implements the pure `@fastagent-sh/client` `Agent` interface (`info`, `usage`, `sessions`, `messages`) — no shared internal `LoopPort`.
- Zero dependency on `@earendil-works/pi-durable`; `@fastagent-sh/fastagent` has zero dependency on `@deepseek-ai/*`.
- Keeps `@deepseek-ai/dsh-*` in optional `peerDependencies` until upstream reaches a stable release.
- Targets full compliance with `test/harnesses/agent-api-conformance.ts` while bringing native OS sandboxing (`sandbox-exec`, `bwrap` / `Landlock`, Windows ACL) and lightweight SQLite/PostgreSQL `SessionPersistence`.
