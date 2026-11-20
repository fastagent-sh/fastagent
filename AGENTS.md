# fastagent — Agent Guide

FastAgent turns a file-defined agent (`SYSTEM.md`, `AGENTS.md`, `skills/`, code under `src/`) into a live service: in
an app, over HTTP, or on a clock, all through one API of its own, the Agent API. Chat platforms reach an agent through
that API from outside the runtime: channels are not part of it.

## The code is the only source of truth

- What FastAgent does is what `packages/*/src/` does. Nothing else describes the implementation. A file's header says
  what the file owns and why it is that way, next to the code the reason is about. Read the code and its headers. Start
  from `packages/fastagent/src/index.ts` (the package), `packages/client/src/agent-api.ts` (the Agent API),
  `packages/client/src/http/contract.ts` (the API over HTTP) and `packages/fastagent/src/cli/program.ts` (the CLI).
- **The packages.** An npm workspace, one version for all: `@fastagent-sh/client` (the Agent API, `connectAgent`, and
  `connectAgentCore` under `/agentcore`; it imports no runtime), `@fastagent-sh/fastagent` (the runtime and the CLI),
  `@fastagent-sh/agentcore` (Amazon Bedrock AgentCore: its runtime, Aurora DSQL, Secrets Manager, EventBridge alarms,
  and its CDK construct) and `@fastagent-sh/pi-remote` (the Pi extension connecting local Pi sessions to deployed
  FastAgent instances; host-provided `@earendil-works/pi-*` packages stay in optional `peerDependencies`). A package reaches another only by name, and in the repository reads its source through the
  `@fastagent-sh/source` export condition; `test/guards/package-boundary.test.ts` holds the lines.
- `docs/` is for users: how to author, run, connect, embed and deploy an agent, and the Agent API they call
  (`docs/agent-api.md`). A guide says what a user does and sees. It never says how the code does it: no internal module,
  state file, call order or history.
- When a doc and the code disagree, the code is right. Fix the doc or delete the passage. A change in what a user does
  or sees updates its guide in the same PR. A CLI command's flags are its `--help`, generated from `packages/fastagent/src/cli/program.ts`.
- Do not commit design notes, plans, measurements or progress logs. They go in the PR description. Anything that
  stays true goes into the code: a name, a header, a test.
- There is no specification document: one implementation and the client it ships need none. The Agent API is
  `packages/client/src/agent-api.ts` and `packages/client/src/http/contract.ts`; what it promises is `docs/agent-api.md`, and
  `test/harnesses/agent-api-conformance.ts` and `test/unit/agent-api/http-api.test.ts` test those promises. Changing them is an explicit
  decision. A second implementation is when a specification would earn its place.

## Decisions the code cannot show

- **One harness, pi-durable.** A harness-neutral layer was tried and dropped: it cost more than it bought.
  `@earendil-works/pi-*` is imported only under `packages/fastagent/src/harnesses/`. An author's tools and extensions are pi-durable code,
  by choice.
- **The contracts import no harness.** The client's `agent-api.ts` imports only `effect/Schema`; the runtime's
  `mcp-api.ts` imports nothing. Each package's `src/index.ts` names every export and exports no assembly
  part (`openServing`, `serveAgent`, `openDurableAgent` stay internal). `test/guards/package-boundary.test.ts` checks this.
- **One process owns an instance's state.** That state is the instance's storage (its SQLite file, or its rows in the
  PostgreSQL database `FASTAGENT_DATABASE_URL` names) and each Caller's files under the state root. A deployment
  routes every session of one storage to one process. What a Caller reads back is durable before it is reported.
- **The artifact carries the agent; the machine lends it an environment.** Prompt files, `AGENTS.md`, `src/` and
  `skills/` come from the bundle, never from the machine (no skill or prompt from `~/.pi/agent`). The box supplies
  only commands and variables, the way `bash` inherits `PATH`.
- **A session id belongs to the Agent; a conversation id belongs to the Caller.** A Caller maps its conversations onto
  sessions (`packages/fastagent/src/schedule/conversation-sessions.ts`). A tool that asks which session it runs in gets the id the Agent handed out
  (`sessionIdOf`).
- **The CLI serves a person and a coding agent alike.** Nothing waits on a terminal. A choice not given exits 2 and
  names what to pass. A step only a person can take returns at once (`need_user_action`, a check command), and a
  process of the CLI's own finishes it. A secret is never typed into the agent's conversation.
  Results go to stdout, everything else to stderr. A command whose result is data has `--json`.

## Engineering rules

- **Fail visibly.** A message that cannot be answered ends `failed`, and its `error` says why. A refused operation
  rejects with an `AgentError`. A stream is refused on its first read. Once it has delivered anything, a failure ends
  it with a `stream_error` event, never a rejection.
- **Effect first, learned from its source.** Write with Effect rather than hand-rolled async plumbing. Read
  `node_modules/effect/AGENTS.md` and the module under `node_modules/effect/src/` before using an API. Never edit it or
  import from inside it.
- **A finalizer does not fail.** Since effect 4.0.6, a defect in a combined cause turns every typed failure into a
  defect, so a finalizer that dies hides the body's failure. A finalizer logs its own failure, or leaves it to an
  explicit call in the body.
- **The run plane and the observation plane read the same state through the same function.** What will execute and
  what is reported must not be derived separately.
- **A convention with four enforcers has none.** When several call sites must each remember a thing, put it in one
  function they all call, and make that function repair rather than trust (`writeFileAtomic`).

## Tests

**What the suite tests: user-visible contracts and high-risk invariants, never wiring.** A test proves either a contract
a user or host relies on (through the entry they call: Agent API, CLI command, package export, generated
files) or a pure/concurrency invariant whose failure silently corrupts state or security. Each contract gets one test for
its main case, one for each promised refusal, and one for each security boundary. Never test internal call order,
private helpers, or non-actionable wording.

See [`test/README.md`](test/README.md) for the double inventory and suite index.

**Tiers are set by the resources a test uses.** Pick the smallest tier that can prove the behavior:

| Layer / Tier | Files, command | Scope & allowed resources | Timeout |
| --- | --- | --- | --- |
| Guards (L0) | `test/guards/*.test.ts`, `npm run test:guards` | Static export/dependency boundaries, double parity, command coverage, and hygiene rules | 20 s |
| Unit (L1) | `test/unit/<domain>/*.test.ts`, `npm test` | Pure invariants (no I/O) and contract specs via standard doubles, temp dirs, SQLite, loopback sockets, fake timers. No child processes. | 20 s |
| Integration (L2) | `test/integration/**/*.integration.test.ts`, `npm run test:integration` | Double parity checks, cross-process locks/signals/pipes, real `build`/`tsc`/`git`/MCP subprocesses, `npm pack` | 30 s |
| Artifact smoke (L3) | CI only: `test/smoke/e2e/packed.ts` | Installed tarball without `src/` aliases | the job |

**Change-to-Test Matrix:**

| Change area | Required tests | Mandatory seam (do not invent a local mock) |
| --- | --- | --- |
| Agent API / HTTP (`packages/client/src/agent-api.ts`, `src/http/` in both packages) | `test/harnesses/agent-api-conformance.ts`, `test/unit/agent-api/http-api.test.ts` | `durableSubject` / `httpSubject` |
| CLI command or flag (`packages/fastagent/src/cli/`) | `test/unit/cli/`: main path, exit 2/1 refusals, `--json` shape | `runInProcess` (`test/doubles/cli-run.ts`); tickets mock `startTicket` and run `--ticket <id>` |
| Deploy (`packages/fastagent/src/deploy/`) | `test/unit/deploy/`: preflight gates, generated artifacts | No secrets in artifacts |
| Security boundary | `test/unit/security/`: valid pass + explicit refusal naming the error | **Mutation check:** break the guard and watch the new test fail before keeping it |
| Test double (`test/doubles/*-double.ts`, `cli-run.ts`) | Update its `test/integration/double-parity/*.integration.test.ts` parity test | Same inputs against the double and the real tool must match |
| Bugfix | Minimal regression test reproducing the bug | L1 preferred; use L2 only when process/lock/tool behavior is essential |

**How the suite stays fast and consistent:**
- **Scoped local loop:** Iterate on the domain you touched (`npx vitest run test/unit/<domain>/` and `npm run test:guards`), then run the full local loop before pushing.
- **Append before creating:** When adding fewer than ~8 tests in an existing domain, append to that domain's test file instead of opening a new `.test.ts` file (each file in `pool: "forks"` pays a cold-import cost).
- **Canonical seams only:** Use `runInProcess` for CLI tests (never spy on `process.cwd`/`console.log`), `git-double.ts`, `tsc-double.ts`, `storage-no-wait.ts`, and `scripted-agent.ts`.
- **Hermetic isolation (`test/setup.ts`, `test/unit-setup.ts`):** Every file gets an empty `HOME`, `FASTAGENT_OFFLINE=1`, stripped proxy env vars, non-loopback network refusal (inherited by Node children via `NODE_OPTIONS`), and child-process refusal in unit tests. Unit tests run shuffled (`--sequence.seed=<n>` repeats an order).
- **Hygiene guards (`test/guards/suite-hygiene.test.ts`):** Bare `.toThrow()`, elapsed-time upper bounds, shared temp parent paths (`join(dir, "..", name)` instead of `besideAgent(dir, name)`), ghost file references, missing double parity, missing CLI command tests, and CLI seam bypasses are rejected.
- **Process CLI tests (`run`):** Spawn the binary in `test/integration/` only for pipes, signals, or processes that outlive the caller (`cli-run-parity.integration.test.ts` pins parity with `runInProcess`).
- **Paired fixtures:** A subject tested in both Unit and Integration shares `test/fixtures/<name>-fixtures.ts`.

## Priorities

FastAgent is a developer-experience product. Its promise is that an existing agent definition becomes a service
without being rewritten. When the following conflict, the earlier one wins; name the trade-off when you break one.
1. The author's velocity: fast `dev`/`start`, every failure actionable, `init` complete by default.
2. Incremental change, for authors and for this code: migrate in place rather than rewrite.
3. Clarity: show the right complexity where the user meets it, with plain names and APIs.
4. Re-evaluate assumptions as models, clouds and harnesses change. Do not stack complex abstractions on complex
   systems.
5. Option value: clear API boundaries and modular seams. Do not design for a second implementation before one exists.

## Workflow

`CONTRIBUTING.md` has the full workflow: branches, the PR loop, releases, merge and review policy.
- Iterate with the guards and domain tests for what you changed (`npm run test:guards && npx vitest run test/unit/<domain>/`). Before pushing, run
  `npm run lint && npm run typecheck && npm test`, plus `npm run test:integration` when the change touches that tier.
- Never commit to `main`. Use a branch prefix (`feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`),
  then `gh pr create --base main --assignee @me`. PRs are squash-merged: the PR title and body become the commit, so
  state the final behavior and its reasons there.
- After opening a PR, report it with the local gate result and stop; do not wait for CI. Merge only when a maintainer
  says so: `gh pr merge <N> --squash --auto`. Report whether the output shows the PR merged or auto-merge enabled.
- Clean up a branch only once `gh pr view <N> --json state -q .state` prints `MERGED`.
- `gh issue create` cannot read the issue forms, so pass `--type Bug --label bug` (or `Feature`/`enhancement`,
  `Task`/`chore`).
- Releases publish from CI through npm Trusted Publishing, never with a local `npm publish` (CONTRIBUTING.md,
  "Releases").

## Communication

Everything in or on the repository is English: code, comments, docs, commits, PRs, reviews, issues, release notes. The
reader is a senior engineer with full context. Lead with the conclusion, use tables for comparisons, do not restate,
and cut what loses no information.
