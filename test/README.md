# Test Suite Guide

This suite follows a four-layer layout (see [AGENTS.md](../AGENTS.md#tests)):

```text
test/
├── guards/       # [L0] package boundaries, test hygiene, runtime isolation guards
├── doubles/      # Shared test doubles (protocol/ holds WS stand-ins)
├── harnesses/    # Multi-suite conformance, channel sandbox, and package harnesses
├── fixtures/     # Shared unit+integration fixtures and static shims
├── unit/         # [L1] domain suites: agent-api, definition, cli, channels, deploy, schedules, embedding, security
├── integration/  # [L2] double-parity, process-and-locks, real-toolchain
└── smoke/        # [L3, CI-only] e2e/packed.ts
```

## Canonical Doubles & Harnesses

Use these shared seams instead of writing per-file mocks:

| Seam | Replaces | Parity / verification |
| --- | --- | --- |
| `doubles/cli-run.ts` (`runInProcess`, `fauxAgent`, `agentWorkspace`) | Spawning `packages/fastagent/src/cli.ts` for command logic | `integration/double-parity/cli-run-parity.integration.test.ts` |
| `doubles/git-double.ts` (`gitAnswersIn`) | `packages/fastagent/src/git.ts` | `integration/double-parity/git-double.integration.test.ts` |
| `doubles/tsc-double.ts` | `packages/fastagent/src/harnesses/pi-durable/tsc.ts` | `integration/double-parity/tsc-double.integration.test.ts` |
| `doubles/storage-no-wait.ts` | `packages/fastagent/src/harnesses/pi-durable/storage.ts` lock wait | Fails immediately on held SQLite lock |
| `doubles/codex-model.ts`, `kept-catalog.ts` | Model providers and catalog refreshes | pi-ai's `fauxProvider` |
| `doubles/scripted-agent.ts`, `scripted-run.ts` | `Agent` for channel/scheduler specs | Conforms to `packages/client/src/agent-api.ts` |
| `harnesses/channel-harness.ts` | Channel suite setup, fetch settle, queue drain | Shared by `telegram`, `slack`, `feishu` suites |
| `harnesses/agent-api-conformance.ts`, `durable-subject.ts`, `http-subject.ts` | `Agent` API contract over `pi-durable` and HTTP | `unit/agent-api/{durable-agent,http-api}.test.ts` |
| `doubles/protocol/*` | Protocol servers (Slack's Socket Mode) | Local WebSocket protocol checks |

## Quick Commands

```bash
npm run test:guards                  # <1s: L0 architectural & suite hygiene guards
npx vitest run test/unit/<domain>/   # Fast scoped iteration on the domain you touched
npm run lint && npm run typecheck && npm test
npm run test:integration             # Required when touching processes, locks, build, git, or doubles
```
