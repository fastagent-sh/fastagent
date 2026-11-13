# Test Suite Guide

This suite follows a four-layer layout (see [AGENTS.md](../AGENTS.md#tests)):

```text
test/
├── guards/       # [L0] package boundaries, test hygiene, runtime isolation guards
├── doubles/      # Shared test doubles (protocol/ holds Bun & WS stand-ins)
├── harnesses/    # Multi-suite conformance, channel sandbox, and package harnesses
├── fixtures/     # Shared unit+integration fixtures and static shims
├── unit/         # [L1] domain suites: agent-api, definition, cli, channels, deploy, schedules, embedding, security
├── integration/  # [L2] double-parity, process-and-locks, real-toolchain
└── smoke/        # [L3, CI-only] e2e/packed.ts and bun/ runtime checks
```

## Canonical Doubles & Harnesses

Use these shared seams instead of writing per-file mocks:

| Seam | Replaces | Parity / verification |
| --- | --- | --- |
| `doubles/cli-run.ts` (`runInProcess`, `fauxAgent`, `agentWorkspace`) | Spawning `src/cli.ts` for command logic | `integration/double-parity/cli-run-parity.integration.test.ts` |
| `doubles/host-cli-double.ts` (`hostCli`, `recordHostCli`, `awsRunner`, `spawnRunner`) | `src/deploy/runner.ts` (`fly`, `railway`, `aws`, `docker`) | `integration/double-parity/host-cli-double.integration.test.ts` |
| `doubles/git-double.ts` (`gitAnswersIn`) | `src/git.ts` | `integration/double-parity/git-double.integration.test.ts` |
| `doubles/tsc-double.ts` | `src/harnesses/pi-durable/tsc.ts` | `integration/double-parity/tsc-double.integration.test.ts` |
| `doubles/storage-no-wait.ts` | `src/harnesses/pi-durable/storage.ts` lock wait | Fails immediately on held SQLite lock |
| `doubles/faux.ts`, `codex-model.ts`, `kept-catalog.ts` | Model providers and catalog refreshes | `doubles/faux.ts` over `@earendil-works/pi-ai` |
| `doubles/scripted-agent.ts`, `scripted-run.ts` | `Agent` for channel/scheduler specs | Conforms to `src/agent-api.ts` |
| `harnesses/channel-harness.ts` | Channel suite setup, fetch settle, queue drain | Shared by `telegram`, `slack`, `feishu` suites |
| `harnesses/agent-api-conformance.ts`, `durable-subject.ts`, `http-subject.ts` | `Agent` API contract over `pi-durable` and HTTP | `unit/agent-api/{durable-agent,http-api}.test.ts` |
| `doubles/github-standin.ts` | Remote `https://github.com/*` clones (L2) | Local bare git repos via `insteadOf` |
| `doubles/protocol/*` | Protocol servers for Bun smoke (`smoke/bun/`) | Local HTTP / WebSocket protocol checks |

## Quick Commands

```bash
npm run test:guards                  # <1s: L0 architectural & suite hygiene guards
npx vitest run test/unit/<domain>/   # Fast scoped iteration on the domain you touched
npm run lint && npm run typecheck && npm test
npm run test:integration             # Required when touching processes, locks, build, git, or doubles
```
