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
  (`docs/SPEC.md`). A guide says what a user does and sees. It never says how the code does it: no internal module,
  state file, call order or history.
- When a doc and the code disagree, the code is right. Fix the doc or delete the passage. A change in what a user does
  or sees updates its guide in the same PR. A CLI command's flags are its `--help`, generated from `src/cli/program.ts`.
- Do not commit design notes, plans, measurements or progress logs. They go in the PR description. Anything that
  stays true goes into the code: a name, a header, a test.
- The Agent API's semantics change only by explicit decision. `test/agent-api-conformance.ts` holds the code to
  `docs/SPEC.md`.

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

**What the suite tests: the spec's cases, not the code's.** A test shows a contract a user relies on, as the docs
describe it. It goes through the entry that user has: the Agent API, a CLI command, a package export, a channel's
ingress, or the files a command writes. Each contract gets:
- one test for its main case;
- one for each refusal the docs promise;
- one for each security boundary: a signature or key checked, a URL refused, a secret kept out of argv, an image and a
  page.

Not tested: a module on its own, a state file's format, a state written by hand to stand for a crash, the order calls
reach a module or a host CLI, retries, races, and wording beyond what a user acts on. A bug found there is fixed with a
test that shows it at an entry, if one can. Kept beside the spec cases: the structure guards
(`package-boundary.test.ts`, `test-tiers.test.ts`) and one integration test per double.

**Tiers are set by the resources a test uses.** Use the smallest tier that can show the behavior.

| Tier | Files, command | May use | Timeout |
| --- | --- | --- | --- |
| Unit | `test/*.test.ts`, `npm test` | One process: temp directories, SQLite on a temp file, loopback sockets, the faux model, the shared doubles, fake timers. No child process. | 20 s |
| Integration | `test/*.integration.test.ts`, `npm run test:integration` | This machine: processes, signals, locks between processes, the real build, `git`, `npm pack` | 30 s |
| Artifact smoke | CI only: `test/e2e/packed.ts` on the packed tarball, `test/bun/` on Bun | The package as a user installs it | the job |

How the tiers are kept:
- `test/setup.ts` refuses any connection off the machine, in every tier and in the Node processes a test starts
  (through `NODE_OPTIONS`). `test/unit-setup.ts` refuses child processes in the unit tier. Both fail the test even when
  product code catches the error.
- Every file gets an empty `HOME`, `FASTAGENT_OFFLINE=1` and no proxy variables. Unit tests run shuffled;
  `--sequence.seed=<n>` repeats an order. `vi.waitFor` waits 10 s.
- `test/test-tiers.test.ts` refuses:
  - a bare `.toThrow()`: name the failure instead;
  - an upper bound on elapsed time: show "does not wait" with fake timers, or with a wait longer than the test's
    timeout;
  - `join(dir, "..", name)`: write beside a temp directory with `besideAgent(dir, name)`.
- A unit test reaches a process or a tool through its seam: `runInProcess` for the CLI, a stubbed `fetch`,
  `test/git-double.ts`, `test/tsc-double.ts`, `test/host-cli-double.ts`, `test/storage-no-wait.ts`. Keep one shared
  double per contract (`scripted-agent.ts` for the Agent), each with one integration test against the real thing.
- A CLI test calls the command with `runInProcess`. Spawn it with `run`, in an integration file, only when the test is
  about the process: pipes, signals, a command that outlives its caller. `cli-run-parity.integration.test.ts` pins
  that the two agree. A ticket's command and its step are tested in process, apart: `startTicket` is mocked to record,
  and the step runs as `--ticket <id>`.
- A test that asserts "X must not happen" is unproven until X has happened. Run the mutation that makes it happen and
  watch the test fail.
- A subject tested in both tiers has two files, `<name>.test.ts` and `<name>.integration.test.ts`, with what both need
  in `<name>-fixtures.ts`.

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
