# Contributing to fastagent

This repository follows **GitHub Flow** (single trunk) with a local-first iteration loop. The branch/PR/merge cycle exists to ship verified changes, not to discover bugs in CI.

All repository-facing text — code, comments, docs, commit messages, PR descriptions — is **English**. This is an open-source project for a global audience.

## Branch model

- `main` is the only long-lived branch. It is protected: linear history, required CI, no force-push, no deletion.
- **Never commit directly to `main`.** Every change lands through a pull request.
- Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`, `test/`.

## Local-first iteration

Anything that can be verified locally **must** be verified locally before opening a PR. Pushing speculatively "to see if CI catches it" wastes Actions minutes and pollutes history.

The full local loop is fast:

```bash
npm install
npm run lint           # Biome (format + lint) plus local Markdown link checks; `npm run format` to fix code
npm run typecheck      # tsc --noEmit (covers src and test)
npm test               # vitest --run
```

Tests use faux models by default, so they validate serving mechanics without network or credentials. A live-model smoke test against a real provider is optional and manual; use a temporary agent from `fastagent init`, and authenticate with `fastagent login` or provider API keys. Behind a proxy, set a working `HTTPS_PROXY`.

## Pull request loop

```text
1. git checkout -b feature/<thing>
2. ... change code, iterate locally ...
3. npm run lint && npm run typecheck && npm test
4. git push -u origin feature/<thing>
5. gh pr create --base main --assignee @me   # drop --assignee without push access
6. CI green → merge (see "Merge strategy")
7. After merge: clean up local + remote tracking branches
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

```bash
git checkout main
git pull --ff-only
git branch -d <merged-branch>
git fetch --prune origin
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
- `npm test` passes,
- CI (`Core checks`, Node 22.19 / 24 / 26) is green.

Add or update the smallest relevant tests that prove the change. Reusable SPEC conformance lives in `test/spec-conformance.ts`; one-off product-scenario scripts should be run and then deleted, not committed.

## Merge strategy

**Squash merge only** — the repository settings enforce it (rebase merges and merge commits are disabled). One PR lands as exactly one commit on `main`, so `main` reads as a sequence of reviewed changes and history stays linear.

- Curate the PR title and description: they become the squash commit's subject and body — the durable record of the change. Branch commits are working state; the PR is the design asset.

One branch = one focused change. If a branch grows several unrelated changes, split it into multiple PRs rather than squashing them into an opaque blob.

## Review policy

A maintainer is a collaborator with write or admin access. The project is open source: every change lands through a reviewed PR, without exception.

- **Merging is an explicit maintainer decision.** Green CI makes a PR *eligible*; a maintainer *lands* it. An agent stops at "CI green, ready to merge" and merges only when a maintainer says so.
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
