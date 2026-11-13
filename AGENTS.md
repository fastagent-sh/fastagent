# fastagent — Agent Guide

FastAgent turns a file-defined agent (`SYSTEM.md`, `AGENTS.md`, `skills/`, code under `src/`) into a live service: in
an app, on Telegram, Slack or Feishu, on a clock, or behind a custom channel, all through one API of its own, the
Agent API.

## The code is the only source of truth

- What FastAgent does is what `src/` does. Nothing else describes the implementation. A file's header says what the
  file owns and why it is that way, next to the code the reason is about. Read the code and its headers. Start from
  `src/index.ts` (the package), `src/agent-api.ts` (the Agent API), `src/http/contract.ts` (the API over HTTP) and
  `src/cli/program.ts` (the CLI).
- `docs/` is for users: how to author, run, connect, embed and deploy an agent, and the Agent API they call
  (`docs/agent-api.md`). A guide says what a user does and sees. It never says how the code does it: no internal module,
  state file, call order or history.
- When a doc and the code disagree, the code is right. Fix the doc or delete the passage. A change in what a user does
  or sees updates its guide in the same PR. A CLI command's flags are its `--help`, generated from `src/cli/program.ts`.
- Do not commit design notes, plans, measurements or progress logs. They go in the PR description. Anything that
  stays true goes into the code: a name, a header, a test.
- There is no specification document: one implementation and the client it ships need none. The Agent API is
  `src/agent-api.ts` and `src/http/contract.ts`; what it promises is `docs/agent-api.md`, and
  `test/agent-api-conformance.ts` and `test/http-api.test.ts` test those promises. Changing them is an explicit
  decision. A second implementation is when a specification would earn its place.

## Decisions the code cannot show

- **One harness, pi-durable.** A harness-neutral layer was tried and dropped: it cost more than it bought.
  `@earendil-works/pi-*` is imported only under `src/harnesses/`. An author's tools and extensions are pi-durable code,
  by choice.
- **The contracts import no harness.** `src/agent-api.ts` imports only `effect/Schema`. `src/channel.ts`,
  `src/sign-in-api.ts` and `src/mcp-api.ts` import nothing. `src/index.ts` names every export and exports no assembly
  part (`openServing`, `serveAgent`, `openDurableAgent` stay internal). `test/package-boundary.test.ts` checks this.
- **One process owns an instance's state.** That state is the instance's SQLite storage and each Caller's files under
  the state root. A deployment routes every session of one storage to one process. What a Caller reads back is
  durable before it is reported.
- **The artifact carries the agent; the machine lends it an environment.** Prompt files, `AGENTS.md`, `src/` and
  `skills/` come from the bundle, never from the machine (no skill or prompt from `~/.pi/agent`). The box supplies
  only commands and variables, the way `bash` inherits `PATH`.
- **A session id belongs to the Agent; a conversation id belongs to the Caller.** A Caller maps its conversations onto
  sessions (`src/conversation-sessions.ts`). A tool that asks which session it runs in gets the id the Agent handed out
  (`sessionIdOf`).
- **The CLI serves a person and a coding agent alike.** Nothing waits on a terminal. A choice not given exits 2 and
  names what to pass. A step only a person can take returns at once (`need_user_action`, a check command), and a
  process of the CLI's own finishes it (`src/cli/ticket.ts`). A secret is never typed into the agent's conversation.
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
a user or host relies on (through the entry they call: Agent API, CLI command, package export, channel ingress, generated
files) or a pure/concurrency invariant whose failure silently corrupts state or security. Each contract gets one test for
its main case, one for each promised refusal, and one for each security boundary. Never test internal call order,
private helpers, or non-actionable wording.

See [`test/README.md`](test/README.md) for the double inventory and suite index.

**Tiers are set by the resources a test uses.** Pick the smallest tier that can prove the behavior:

| Layer / Tier | Files, command | Scope & allowed resources | Timeout |
| --- | --- | --- | --- |
| Guards (L0) | `test/package-boundary.test.ts`, `test/test-tiers.test.ts`, `test/forbidden.test.ts` | Static export/dependency boundaries and test-suite rules | 20 s |
| Unit (L1) | `test/*.test.ts`, `npm test` | Pure invariants (no I/O) and contract specs via standard doubles, temp dirs, SQLite, loopback sockets, fake timers. No child processes. | 20 s |
| Integration (L2) | `test/*.integration.test.ts`, `npm run test:integration` | Double parity checks, cross-process locks/signals/pipes, real `build`/`tsc`/`git`/MCP subprocesses, `npm pack` | 30 s |
| Artifact smoke (L3) | CI only: `test/e2e/packed.ts`, `test/bun/` | Installed tarball without `src/` aliases and Bun 1.4 runtime differences | the job |

**Change-to-Test Matrix:**

| Change area | Required tests | Mandatory seam (do not invent a local mock) |
| --- | --- | --- |
| Agent API / HTTP (`src/agent-api.ts`, `src/http/`) | `test/agent-api-conformance.ts`, `test/http-api.test.ts` | `durableSubject` / `httpSubject` |
| CLI command or flag (`src/cli/`) | Main path, exit 2/1 refusals, `--json` shape | `runInProcess` (`test/cli-run.ts`); tickets mock `startTicket` and run `--ticket <id>` |
| Channel (`src/channels/`) | Verified ingress, DM/group summon, `/stop`, send tool | `scriptedAgent` (`test/scripted-agent.ts`) + stubbed `fetch` |
| Deploy / Host CLI (`src/deploy/`) | Preflight gates, generated artifacts, `run`/`destroy`/`logs` paths | `hostCli` / `recordHostCli` (`test/host-cli-double.ts`); no secrets in artifacts or argv |
| Security boundary | Valid pass + explicit refusal naming the error | **Mutation check:** break the guard and watch the new test fail before keeping it |
| Test double (`test/*-double.ts`, `test/cli-run.ts`) | Update its `*.integration.test.ts` parity test | Same inputs against the double and the real tool must match |
| Bugfix | Minimal regression test reproducing the bug | L1 preferred; use L2 only when process/lock/tool behavior is essential |

**How the suite stays fast and consistent:**
- **Append before creating:** When adding fewer than ~8 tests in an existing domain, append to that domain's test file instead of opening a new `.test.ts` file (each file in `pool: "forks"` pays a cold-import cost).
- **Canonical seams only:** Use `runInProcess` for CLI tests (never stub `process.cwd`/`console.log`/`process.exitCode` manually), `host-cli-double.ts` for host CLIs (never write a local `fakeCli`), `git-double.ts`, `tsc-double.ts`, `storage-no-wait.ts`, `faux.ts`, and `scripted-agent.ts`.
- **Hermetic isolation (`test/setup.ts`, `test/unit-setup.ts`):** Every file gets an empty `HOME`, `FASTAGENT_OFFLINE=1`, stripped proxy env vars, non-loopback network refusal (inherited by Node children via `NODE_OPTIONS`), and child-process refusal in unit tests. Unit tests run shuffled (`--sequence.seed=<n>` repeats an order).
- **Hygiene guards (`test/test-tiers.test.ts`):** Bare `.toThrow()`, elapsed-time upper bounds (`Date.now() - t < ...`), and shared temp parent paths (`join(dir, "..", name)` instead of `besideAgent(dir, name)`) are rejected.
- **Process CLI tests (`run`):** Spawn the binary in an integration test only for pipes, signals, or processes that outlive the caller (`cli-run-parity.integration.test.ts` pins parity with `runInProcess`).
- **Paired fixtures:** A subject tested in both Unit and Integration shares `<name>-fixtures.ts`.

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
- Iterate with the tests for what you changed (`npx vitest run test/<file>.test.ts`). Before pushing, run
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
