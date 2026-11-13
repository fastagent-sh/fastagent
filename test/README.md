# Test Suite Guide

This suite follows a four-layer model (see [AGENTS.md](../AGENTS.md#tests)):

1. **Guards (L0):** `package-boundary.test.ts`, `test-tiers.test.ts`, `forbidden.test.ts`.
2. **Unit (L1):** `test/*.test.ts` (`npm test`) — pure invariants and contract specs running in-process on hermetic doubles.
3. **Integration (L2):** `test/*.integration.test.ts` (`npm run test:integration`) — double parity checks, cross-process locks/signals/pipes, real `build`/`tsc`/`git`/MCP subprocesses.
4. **Artifact & Runtime Smoke (L3, CI-only):** `test/e2e/packed.ts` (tarball install smoke) and `test/bun/*.ts` (Bun 1.4 compatibility).

## Canonical Doubles & Harnesses

Use these shared seams instead of writing per-file mocks:

| Seam | Replaces | Parity / verification |
| --- | --- | --- |
| `cli-run.ts` (`runInProcess`, `fauxAgent`, `agentWorkspace`) | Spawning `src/cli.ts` for command logic | `cli-run-parity.integration.test.ts` |
| `host-cli-double.ts` (`hostCli`, `recordHostCli`, `awsRunner`, `spawnRunner`) | `src/deploy/runner.ts` (`fly`, `railway`, `aws`, `docker`) | `host-cli-double.integration.test.ts` |
| `git-double.ts` (`gitAnswersIn`) | `src/git.ts` | `git-double.integration.test.ts` |
| `tsc-double.ts` | `src/harnesses/pi-durable/tsc.ts` | `tsc-double.integration.test.ts` |
| `storage-no-wait.ts` | `src/harnesses/pi-durable/storage.ts` lock wait | Fails immediately on held SQLite lock |
| `faux.ts`, `codex-model.ts`, `kept-catalog.ts` | Model providers and catalog refreshes | `test/faux.ts` over `@earendil-works/pi-ai` |
| `scripted-agent.ts`, `scripted-run.ts` | `Agent` for channel/scheduler specs | Conforms to `src/agent-api.ts` |
| `agent-api-conformance.ts`, `durable-subject.ts`, `http-subject.ts` | `Agent` API contract over `pi-durable` and HTTP | `durable-agent.test.ts`, `http-api.test.ts` |
| `github-standin.ts` | Remote `https://github.com/*` clones (L2) | Local bare git repos via `insteadOf` |
| `aws-stand-in.ts`, `slack-stand-in.ts`, `box-shell-stand-in.ts` | Protocol servers for Bun smoke (`test/bun/`) | Local HTTP / WebSocket protocol checks |

## Quick Commands

```bash
npx vitest run test/<file>.test.ts   # Fast local iteration on the file you touched
npm run lint && npm run typecheck && npm test
npm run test:integration             # Required when touching processes, locks, build, git, or doubles
```
