# fastagent — Agent Guide

FastAgent turns a file-defined agent (`SYSTEM.md`, `AGENTS.md`, `skills/`, code under `src/`) into a live service: in
an app or over HTTP, all through one API of its own, the Agent API. Chat platforms reach an agent through
that API from outside the runtime: channels are not part of it.

## The code is the only source of truth

- What FastAgent does is what `packages/*/src/` does. Nothing else describes the implementation. A file's header says
  what the file owns and why it is that way, next to the code the reason is about. Read the code and its headers. Start
  from `packages/fastagent/src/index.ts` (the package), `packages/client/src/agent-api.ts` (the Agent API),
  `packages/client/src/http/contract.ts` (the API over HTTP) and `packages/fastagent/src/cli/program.ts` (the CLI).
- **The packages.** An npm workspace, one version for all, each with an isolated dependency tree: `@fastagent-sh/client` (the cloud-agnostic Agent API and zero-Node-dep `connectAgent` / `connectAuth` HTTP client; it imports no runtime or cloud SDK), `@fastagent-sh/client-agentcore` (zero-Node-dep Amazon Bedrock AgentCore SigV4 client wrapping `connectAgent`), `@fastagent-sh/fastagent` (the cloud runtime, PostgreSQL single-writer lease kit, `HarnessProvider` SDK, and CLI), `@fastagent-sh/agentcore` (pure Amazon Bedrock AgentCore MicroVM server adapter over `openAgent` and PostgreSQL; zero AWS SDK or CDK deps), and `@fastagent-sh/harness-dsh` (optional second server-grade runtime harness backed by `@deepseek-ai/dsh` with native OS sandboxing; loaded lazily by `@fastagent-sh/fastagent` so core carries zero `@deepseek-ai/*` dependencies). A package reaches
  another only by name, and in the repository reads its source through the
  `@fastagent-sh/source` export condition; `test/guards/package-boundary.test.ts` holds the lines.
- `docs/` is for users and developers: product positioning (`docs/overview.md`), technical architecture
  (`docs/architecture.md`), authoring, configuration, remote operations (`docs/remotes.md`), embedding, deployment,
  and the Agent API contract (`docs/agent-api.md`). Docs stay user- and developer-facing and never include process
  logs or design history.
- When a doc and the code disagree, the code is right. Fix the doc or delete the passage. A change in what a user does
  or sees updates its guide in the same PR. A CLI command's flags are its `--help`, generated from `packages/fastagent/src/cli/program.ts`.
- Do not commit design notes, plans, measurements or progress logs. They go in the PR description. Anything that
  stays true goes into the code: a name, a header, a test.
- The Agent API is `packages/client/src/agent-api.ts` and `packages/client/src/http/contract.ts`; what it promises is `docs/agent-api.md`, and `test/harnesses/agent-api-conformance.ts` and `test/unit/agent-api/http-api.test.ts` enforce those promises across both `pi-durable` and `dsh` harnesses. Changing them is an explicit decision.

## Product matrix boundaries

FastAgent is the open-source cloud runtime narrow waist inside a four-part orthogonal product matrix. Keep each concern in its owning repository:

- **`fastagent` (this repository):** Cloud-deployed runtime kernel, immutable agent artifact build (`fastagent build`), server-grade `HarnessProvider` plugins (`pi-durable`, `dsh`), SQLite/PostgreSQL single-writer fenced state, and the canonical `Agent API` (`@fastagent-sh/client`). Targets cloud-embedded backends (`openAgent` / `service.fetch`) and scale-to-zero containers. Never add local desktop/IDE runtime modes, editor `ACP` stdio wrappers, third-party SaaS OAuth vaults, or managed cloud billing here.
- **`duang`:** External capability catalog, progressive 4-meta-tool discovery (`discover`, `inspect`, `call`, `get_call`), and per-team encrypted credential vault exposed to agents via standard remote HTTP `/mcp` and `SKILL.md`.
- **`fastagent-cloud`:** Managed serverless hosting, scale-to-zero compute/sandbox pools, visitor sharing boundaries, and billing for compiled `fastagent` artifacts over the standard `Agent API`.
- **`kage`:** Cross-platform thin client (Web, macOS, mobile) speaking `@fastagent-sh/client` `Agent API` to cloud-deployed `fastagent` instances; owns zero agent runtime or second session store.

## Decisions the code cannot show

- **Two harnesses behind one contract.** `pi-durable` is the built-in default harness and `@fastagent-sh/harness-dsh`
  is an optional second harness with native OS sandboxing. The contract boundary stays strictly at `@fastagent-sh/client`'s
  Agent API + `test/harnesses/agent-api-conformance.ts` (no internal `LoopPort`). `@earendil-works/pi-*` is imported
  only under `packages/fastagent/src/harnesses/`. Every agent definition (`AGENTS.md`, `SYSTEM.md`, `skills/`, `.mcp.json`,
  and `src/tools/` via `defineTool` or Standard JSON Schema v1 tool objects) is 100% portable across both harnesses.
- **The contracts import no harness.** The client's `agent-api.ts` imports only `effect/Schema`; the runtime's
  `mcp-api.ts` imports nothing. Each package's `src/index.ts` names every export and exports no assembly
  part (`openServing`, `serveAgent`, `openDurableAgent` stay internal). `test/guards/package-boundary.test.ts` checks this.
- **One process owns an instance's state.** That state is the instance's storage (its SQLite file, or its rows in the
  PostgreSQL database `FASTAGENT_DATABASE_URL` names) and each Caller's files under the state root. A deployment
  routes every session of one storage to one process. What a Caller reads back is durable before it is reported.
- **The artifact carries the agent; the machine lends it an environment.** Prompt files, `AGENTS.md`, `src/` and
  `skills/` come from the bundle, never from the machine (no skill or prompt from `~/.pi/agent`). The box supplies
  only commands and variables, the way `bash` inherits `PATH`.
- **A session id belongs to the Agent; a conversation id belongs to the Caller.** A tool that asks which session it runs in gets the id the Agent handed out
  (`sessionIdOf`).
- **The CLI serves a person and a coding agent alike.** Nothing waits on a terminal. A choice not given exits 2 and
  names what to pass. A step only a person can take returns at once (`need_user_action`, a check command), and a
  process of the CLI's own finishes it. A secret is never typed into the agent's conversation.
  Results go to stdout, everything else to stderr. A command whose result is data has `--json`.

## Engineering rules

- **Fail visibly.** A message that cannot be answered ends `failed`, and its `error` says why. A refused operation
  rejects with an `AgentError`. A stream is refused on its first read. Once it has delivered anything, a failure ends
  it with a `stream_error` event, never a rejection.
- **Pure functional core, Effect v4 boundaries.** Keep domain transforms, config validation, secret grouping, and
  deploy artifact generation as plain synchronous pure functions over `readonly` inputs using `ES2025` non-mutating
  APIs (`Map.groupBy`, `toSorted`, `Set`, `Iterator`) — never wrap trivial synchronous calculations in `Effect`.
  Isolate I/O, lifecycles (`Scope`, `Deferred`, `Ref`, `Effect.acquireRelease`), operation spans (`Effect.fn`),
  time (`Clock`), secrets (`Redacted<string>`), and env decoding (`packages/fastagent/src/process-env.ts` `Config`)
  in Effect v4. Keep public SDK and runtime entrypoints (`@fastagent-sh/client`, `openAgent`, `serveAgent`) returning
  standard `Promise` / `AsyncIterable` and accepting plain `string` inputs while enforcing `Schema.brand` domain IDs
  (`SessionId`, `ConversationId`, `ConversationKey`, `MessageId`, `IdempotencyKey`) and `Redacted<string>` internally.
  Read `node_modules/effect/AGENTS.md` and `node_modules/effect/src/` before using an API; never edit it or import
  from inside it. `npm run typecheck` runs `@effect/tsgo` with `floatingEffect: "error"`.
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
| CLI command or flag (`packages/fastagent/src/cli/`) | `test/unit/cli/`: main path, exit 2/1 refusals, `--json` shape | `runInProcess` (`test/doubles/cli-run.ts`) |
| Deploy (`packages/fastagent/src/deploy/`) | `test/unit/deploy/`: preflight gates, generated artifacts | No secrets in artifacts |
| Security boundary | `test/unit/security/`: valid pass + explicit refusal naming the error | **Mutation check:** break the guard and watch the new test fail before keeping it |
| Test double (`test/doubles/*-double.ts`, `cli-run.ts`) | Update its `test/integration/double-parity/*.integration.test.ts` parity test | Same inputs against the double and the real tool must match |
| Bugfix | Minimal regression test reproducing the bug | L1 preferred; use L2 only when process/lock/tool behavior is essential |

**How the suite stays fast and consistent:**
- **Scoped local loop:** Iterate on the domain you touched (`npx vitest run test/unit/<domain>/` and `npm run test:guards`), then run the full local loop before pushing.
- **Append before creating:** When adding fewer than ~8 tests in an existing domain, append to that domain's test file instead of opening a new `.test.ts` file (each file in `pool: "forks"` pays a cold-import cost).
- **Canonical seams only:** Use `runInProcess` for CLI tests (never spy on `process.cwd`/`console.log`), `git-double.ts`, `tsc-double.ts`, `storage-no-wait.ts`, and `scripted-agent.ts`.
- **Hermetic isolation (`test/setup.ts`, `test/unit-setup.ts`):** Every file gets an empty `HOME`, stripped proxy env vars, non-loopback network refusal (inherited by Node children via `NODE_OPTIONS`), and child-process refusal in unit tests. Unit tests run shuffled (`--sequence.seed=<n>` repeats an order).
- **Deterministic Effect & property tests:** Prefer `@effect/vitest` (`it.effect` with `TestClock` from `effect/testing`) for TTL, keep-alive, retry/backoff, and scoped lifecycle tests, and `it.prop` / `it.effect.prop` (`effect/Arbitrary`) for Schema codec round-trips and state invariants.
- **Hygiene guards (`test/guards/suite-hygiene.test.ts`):** Bare `.toThrow()`, elapsed-time upper bounds, shared temp parent paths (`join(dir, "..", name)` instead of `besideAgent(dir, name)`), ghost file references, missing double parity, missing CLI command tests, CLI seam bypasses, unauthorized `process.env` access outside approved boundary files, and silent empty `catch {}` blocks are rejected.
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
5. Option value: clear API boundaries and modular seams across `@fastagent-sh/client`, `pi-durable`, and `dsh`. Keep extensions and transport seams minimal without breaking the shared contract.

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

Code, comments, commits, PRs, reviews, issues, release notes, and primary documentation are in English. User-facing
documentation also maintains a Simplified Chinese mirror (`README.zh-CN.md` and `docs/zh-CN/`), kept in sync with
the code and English originals. The reader is a senior engineer with full context. Lead with the conclusion, use tables
for comparisons, do not restate, and cut what loses no information.
