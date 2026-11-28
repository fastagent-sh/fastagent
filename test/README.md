# Test Suite Guide

This suite follows a four-layer layout (see [AGENTS.md](../AGENTS.md#tests)):

```text
test/
├── guards/       # [L0] package boundaries, test hygiene, runtime isolation guards
├── doubles/      # Shared test doubles
├── harnesses/    # Multi-suite conformance and package harnesses
├── fixtures/     # Shared unit+integration fixtures and static shims
├── unit/         # [L1] domain suites: agent-api, cli, definition, deploy, embedding, harness-dsh, security, storage, traces
├── integration/  # [L2] double-parity, process-and-locks, real-toolchain
└── smoke/        # [L3] CI packed E2E (`e2e/packed.ts`, `e2e/examples.ts`) and Bun 1.4.4 runtime/CLI smoke (`bun/runtime.ts`)
```

## Canonical Doubles & Harnesses

Use these shared seams instead of writing per-file mocks:

| Seam | Replaces | Parity / verification |
| --- | --- | --- |
| `doubles/cli-run.ts` (`runInProcess`, `fauxAgent`, `agentWorkspace`) | Spawning `packages/fastagent/src/cli.ts` for command logic | `integration/double-parity/cli-run-parity.integration.test.ts` |
| `doubles/git-double.ts` (`gitAnswersIn`) | `packages/fastagent/src/git.ts` | `integration/double-parity/git-double.integration.test.ts` |
| `doubles/tsc-double.ts` | `packages/fastagent/src/definition/tsc.ts` | `integration/double-parity/tsc-double.integration.test.ts` |
| `doubles/postgres-double.ts` (`servedPostgres`) | A PostgreSQL server (PGlite on a loopback port) | `integration/double-parity/postgres-double.integration.test.ts`, against `FASTAGENT_TEST_POSTGRES_URL` |
| `doubles/storage-no-wait.ts` | `packages/fastagent/src/harnesses/pi-durable/storage.ts` lock wait | Fails immediately on held SQLite lock |
| `doubles/codex-model.ts` | Model providers | pi-ai's `fauxProvider` |
| `doubles/scripted-agent.ts` | In-memory scripted `Agent` double | Conforms to `packages/client/src/agent-api.ts` |
| `harnesses/agent-api-conformance.ts`, `durable-subject.ts`, `http-subject.ts` | `Agent` API contract over `pi-durable`, `dsh`, and HTTP | `unit/agent-api/{durable-agent,http-api}.test.ts`, `unit/harness-dsh/dsh-conformance.test.ts` |

## Quick Commands

```bash
npm run test:guards                  # <1s: L0 architectural & suite hygiene guards
npx vitest run test/unit/<domain>/   # Fast scoped iteration on the domain you touched
npm run lint && npm run typecheck && npm test
npm run test:integration             # Required when touching processes, locks, build, git, or doubles
```
