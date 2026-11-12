# Contributing to fastagent

This repository follows **GitHub Flow** (single trunk) with a local-first iteration loop. The branch/PR/merge cycle exists to ship verified changes, not to discover bugs in CI.

All repository-facing text — code, comments, docs, commit messages, PR descriptions — is **English**. This is an open-source project for a global audience.

## Branch model

- `main` is the only long-lived branch. It is protected: linear history, required CI, no force-push, no deletion.
- **Never commit directly to `main`.** Every change lands through a pull request.
- Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`.

## Local-first iteration

Anything that can be verified locally **must** be verified locally before opening a PR. Pushing speculatively "to see if CI catches it" wastes Actions minutes and pollutes history.

While iterating, run the test files for the code you changed (`npx vitest run test/<file>.test.ts`). Run the full local loop once, before pushing:

```bash
npm install
npm run lint           # Biome (format + lint) plus local Markdown link checks; `npm run format` to fix code
npm run typecheck      # tsc --noEmit (covers src and test)
npm test               # the unit tier
```

Run `npm run test:integration` as well when the change touches what that tier tests (processes, signals, locks
between processes, the build, git, the host CLIs); CI runs it on every PR. CI runs both tiers on Linux, which checks the
paths only Linux takes (`flock`, `dpkg`, `/proc`) that a run on macOS skips.

Tests use faux models by default, so they validate serving mechanics without network or credentials. A live-model smoke test against a real provider is optional and manual; use a temporary agent from `fastagent init`, and authenticate with `fastagent login` or provider API keys. Behind a proxy, set a working `HTTPS_PROXY`.

## Test tiers

A test's tier is decided by what it uses, so the test infrastructure can check it, rather than by how much code it
covers. Write the smallest tier that can show the behavior.

| Tier | Files | May use | May not use | Timeout | Runs |
| --- | --- | --- | --- | --- | --- |
| **Unit** | `test/*.test.ts` | This process: real modules working together, temp directories, SQLite on a temp file, loopback sockets, the faux model, the shared doubles (`scripted-agent.ts`, a stubbed `fetch`, `runInProcess`), fake timers | A child process of any kind (the CLI, `git`, `tsc`, a stand-in script), a connection off the machine, a bound on how long something took, waiting out a real timeout | 20 s | `npm test`, on every Node version CI tests |
| **Integration** | `test/*.integration.test.ts` | This machine: processes and process groups, signals, locks between processes, the project's real build, `git`, `npm pack`, stand-in host CLIs on the `PATH` | A connection off the machine, a real platform or cloud, a bound on how long something took | 30 s | `npm run test:integration`, on the Node floor |
| **Artifact smoke and end to end** | CI's `Packed package smoke` (with `test/e2e/packed.ts`: `init`, `invoke`, `build`, and the build opened by an app, on the packed tarball with a faux model) and `Bun smoke` (`test/bun/`) | The package as a user installs it, `dist/`, Bun, npm's registry for its dependencies | Anything aliased to `src/` | (the job) | CI |

How the boundary is kept:

- `test/setup.ts` refuses a connection to anything but loopback in every tier, and `test/unit-setup.ts` refuses a child
  process in the unit tier. Both throw where the call is made and fail the test afterwards, so product code that
  catches the error cannot hide it. A name is judged by the address it resolves to. The guard is in the test's own
  process: a child process an integration test starts is kept off the network by its environment, not by the guard.
- The machine a test runs on is the same everywhere: `test/setup.ts` gives every file an empty `HOME`,
  `FASTAGENT_OFFLINE=1` (no model catalog fetched) and no proxy variables, and `run`/`runInProcess` keep the first two
  in an environment a test gives them whole. A test whose subject is one of them sets it itself.
- Unit tests run in a random order within each file, so none leans on another having run first. A run prints its seed
  (`Running tests with seed "<n>"`); `npx vitest run --project unit --sequence.seed=<n>` repeats the order.
- `test/test-tiers.test.ts` refuses a bound on how long something took (`Date.now()` minus a start, below a limit):
  load decides it as much as the code does. A lower bound, that the code waited, is allowed. To show something does
  not wait, drive the time with fake timers, or make the wait it must not take longer than the test's timeout (inject
  it, or ask for the longest one there is), so the timeout is the bound with a margin no load closes. A regular
  expression is shown linear the same way: an input on which a backtracking one runs for over a minute.
- `vi.waitFor` waits 10 s unless told otherwise (`test/setup.ts`; vitest's own default is 1 s). A wait that is met
  returns at once, so only a failing test pays for the longer budget.
- A file a test writes outside its temp directory goes in `besideAgent(dir, name)` (`test/cli-run.ts`), never
  `join(dir, "..", name)`: the parent of a temp directory is the machine's, shared by every test process and every run.
  `test-tiers.test.ts` refuses the second.
- Where a unit test needs what a process or a tool would answer, it goes through the seam the code already has: the
  in-process CLI (`runInProcess`), a stubbed `fetch`, `test/git-double.ts` for `src/git.ts`, `test/tsc-double.ts` for
  the build's compiler, `test/host-cli-double.ts` for the host CLIs (`src/deploy/runner.ts`), `test/storage-no-wait.ts`
  for a held database. A ticket's command and step run in process apart (`cli-login-ticket.test.ts`). A double gets one integration test that checks it
  against the real thing, as `cli-run-parity.integration.test.ts` does for `runInProcess`.
- A subject tested in both tiers is two files, `<name>.test.ts` and `<name>.integration.test.ts`; what both need is in
  `<name>-fixtures.ts`.

Platform contracts (what Telegram, Slack or Feishu really return) are not tested in any tier: they are measured and
recorded in the design docs.

## Pull request loop

```text
1. git checkout -b feature/<thing>
2. ... change code, iterate locally ...
3. npm run lint && npm run typecheck && npm test   # and npm run test:integration when it applies
4. git push -u origin feature/<thing>
5. gh pr create --base main --assignee @me   # drop --assignee without push access
6. gh pr merge <N> --squash --auto   # a maintainer's call; merges now or once CI passes (see "Merge strategy")
7. After it merges: clean up local + remote tracking branches
```

### Issue and PR metadata

Most of the sidebar fills itself; the rest is one flag. What is automatic and what is not:

| Field | Issues | Pull requests |
| --- | --- | --- |
| Type (`Bug` / `Feature` / `Task`) | Automatic in the browser — each issue form declares one | Not applicable |
| Labels | Automatic in the browser — the form's `labels:` (Task files as `chore`) | Automatic — the branch prefix, via `.github/labeler.yml` |
| Reviewer | Not applicable | Automatic — CODEOWNERS |
| Assignee | Whoever picks it up | `--assignee @me`, and only with push access |
| Projects, Priority, Milestone | Board fields; set them on the board | Board fields too — `Closes #<n>` closes the issue, it does not carry them over |

The forms fill the sidebar only in the browser — which is where contributors without push access should open issues, since the API silently drops `--type` and `--label` for them. `gh issue create` cannot use the forms at all: it discovers templates through GraphQL `repository.issueTemplates`, which does not return issue forms ([cli/cli#5865](https://github.com/cli/cli/issues/5865)). With push access, pass the two fields explicitly:

```bash
gh issue create --title "bug: <what>" --body "<detail>" --type Bug --label bug   # Feature/enhancement, Task/chore
gh pr create --base main --assignee @me        # labels and reviewers are added for you
```

Without push access, drop `--assignee`: `gh` resolves the login against the repository's assignable users and aborts with `'<login>' not found` before the pull request is created.

A PR whose branch prefix matches no rule in `.github/labeler.yml` gets no label, and nothing says so: the job stays green and the label field is silently empty.

### After a PR merges

A PR waiting on auto-merge lands later, so clean up only once `gh pr view <N> --json state -q .state` prints `MERGED`. A deleted remote branch does not prove that: the branch of a closed PR can be deleted too. Delete the local branch with `-D`: a squashed branch is never an ancestor of `main`, so `-d` refuses it.

```bash
git checkout main
git pull --ff-only
git fetch --prune origin
git branch -D <merged-branch>
```

## Releases

Start from a clean, up-to-date `main` with an authenticated GitHub CLI, then create a release PR:

```bash
npm run release:patch # or release:minor / release:major
```

The script verifies the Git and npm state, updates `package.json` and `package-lock.json`, runs the full local checks plus an npm package dry run, and opens a `chore/release-X.Y.Z` PR. It never merges, tags, or publishes. After a maintainer squash-merges the PR, create and publish GitHub Release `vX.Y.Z`; the protected publish workflow then publishes to npm through Trusted Publishing.

## Validation before merge

A PR is mergeable only when:

- `npm run lint` is clean (Biome format/lint plus local Markdown links; run `npm run format` to auto-fix code),
- `npm run typecheck` is clean (TypeScript with `noUnusedLocals`/`noUnusedParameters`),
- `npm test` passes, and `npm run test:integration` when the change touches what it tests,
- CI (`Core checks`: unit on Node 24.15 / 26, integration and the artifact smoke on 24.15; and `CodeQL`) is green. Branch protection enforces this: a PR whose required checks have not passed cannot merge.

Add or update the smallest relevant tests that prove the change. The Agent API's conformance suite lives in `test/agent-api-conformance.ts`; one-off product-scenario scripts should be run and then deleted, not committed.

## Merge strategy

**Squash merge only** — the repository settings enforce it (rebase merges and merge commits are disabled). One PR lands as exactly one commit on `main`, so `main` reads as a sequence of reviewed changes and history stays linear.

- Curate the PR title and description: they become the squash commit's subject and body — the durable record of the change. Branch commits are working state; the PR is the design asset.
- `gh pr merge <N> --squash --auto` squash-merges the PR at once when its required checks have passed, and otherwise enables auto-merge, which merges it when they do. A PR does not have to be up to date with `main` first, and nobody waits for CI by hand. A PR whose checks fail, or which conflicts with `main`, stays open with auto-merge pending. Whoever runs it reports which of the two its output shows (merged, or auto-merge enabled). There is no merge queue: the checks that decide ran on the PR as last pushed, so two PRs that are each green but break together are caught by CI on `main` after the second lands, not before.

One branch = one focused change. If a branch grows several unrelated changes, split it into multiple PRs rather than squashing them into an opaque blob.

## Review policy

A maintainer is a collaborator with write or admin access. The project is open source: every change lands through a reviewed PR, without exception.

- **Merging is an explicit maintainer decision.** A maintainer decides to land a PR; branch protection makes sure CI is green when it does. An agent opens the PR, reports its local check result and stops. It runs `gh pr merge <N> --squash --auto` only when a maintainer says so, and returns without waiting for CI.
- Maintainer-authored PRs require green CI before merging. Review by a second maintainer is recommended for SPEC and public API changes.
- A PR from an external contributor must be reviewed and merged by a maintainer; external contributors do not have merge permission.
- `CODEOWNERS` routes changes to the relevant maintainers.

All changes still go through a PR. Force-pushing to `main` is forbidden. Long-lived PRs (> ~3 days) should be rebased on `main`.

## Commit and PR messages

- Subject line: `type(scope): summary` (e.g. `fix(config): reject ambiguous config files`).
- Body: explain the durable *why*, not the editing history. Do not narrate intermediate discussion or "fixed it again" cycles.
- Do not commit process scaffolding (`*_PLAN.md`, `HANDOFF.md`, `SESSION_*.md`). Fold durable insight into `AGENTS.md` / `README.md` / `docs/`.

## Dependencies

Dependabot opens weekly PRs for npm and GitHub Actions. The pi packages (`@earendil-works/pi-*`) share one monorepo and move together — update them as a group. Re-run `npm run lint && npm run typecheck && npm test` before merging any dependency bump.

The `undici` version is load-bearing for proxy/streaming behavior under Node 26; see the `installProxyFetch` docstring in `src/proxy.ts` before changing it.

## Issues

Use the issue forms (`Bug report`, `Feature request`). Bug reports must include a minimal reproduction and the environment (Node version, OS, package version/commit, proxy settings).
