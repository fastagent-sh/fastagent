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
5. gh pr create --base main           # fill in the PR template
6. CI green → merge (see "Merge strategy")
7. After merge: clean up local + remote tracking branches
```

### After a PR merges

```bash
git checkout main
git pull --ff-only
git branch -d <merged-branch>
git fetch --prune origin
```

## Validation before merge

A PR is mergeable only when:

- `npm run lint` is clean (Biome format/lint plus local Markdown links; run `npm run format` to auto-fix code),
- `npm run typecheck` is clean (TypeScript with `noUnusedLocals`/`noUnusedParameters`),
- `npm test` passes,
- CI (`Core checks`, Node 22.19 / 24 / 26) is green.

Add or update the smallest relevant tests that prove the change. Reusable SPEC conformance lives in `test/spec-conformance.ts`; one-off product-scenario scripts should be run and then deleted, not committed.

## Merge strategy

**Rebase merge is the default**, not squash. This is a deliberate divergence from squash-only workflows: commit messages in this repo are a design asset — each commit explains one decision — and `main` already enforces linear history. Curated, individually meaningful commits should reach `main` intact.

- **Rebase merge** (default): keep the branch's curated, individually meaningful commits.
- **Squash merge**: collapse a messy WIP branch into one commit before it reaches `main`.
- **Merge commits are disabled** (they break linear history).

Either way, one branch = one focused change. If a branch grows several unrelated changes, split it into multiple PRs rather than squashing them into an opaque blob.

## Review tiers

This is a small team; review is risk-based, not mandatory on everything.

| Change | Review |
|---|---|
| Docs, comments, typos | Self-merge after CI |
| Semantically-equivalent refactor, added tests | Self-merge after CI |
| `docs/SPEC.md` (the locked contract), the `Agent` interface, public API surface in `src/index.ts` | Wait for review |
| Anything that deletes a public export or changes error/terminal semantics | Wait for review |

Force-pushing to `main` is forbidden. Long-lived PRs (> ~3 days) should be rebased on `main`.

## Commit and PR messages

- Subject line: `type(scope): summary` (e.g. `fix(config): reject ambiguous config files`).
- Body: explain the durable *why*, not the editing history. Do not narrate intermediate discussion or "fixed it again" cycles.
- Do not commit process scaffolding (`*_PLAN.md`, `HANDOFF.md`, `SESSION_*.md`). Fold durable insight into `AGENTS.md` / `README.md` / `docs/`.

## Dependencies

Dependabot opens weekly PRs for npm and GitHub Actions. The pi packages (`@earendil-works/pi-*`) share one monorepo and move together — update them as a group. Re-run `npm run lint && npm run typecheck && npm test` before merging any dependency bump.

The `undici` version is load-bearing for proxy/streaming behavior under Node 26; see the `installProxyFetch` docstring in `src/proxy.ts` before changing it.

## Issues

Use the issue forms (`Bug report`, `Feature request`). Bug reports must include a minimal reproduction and the environment (Node version, OS, package version/commit, proxy settings).
