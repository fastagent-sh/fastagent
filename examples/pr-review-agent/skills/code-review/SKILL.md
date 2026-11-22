---
name: code-review
description: Structured engineering review rubric for pull requests (security, correctness, concurrency, error handling, tests).
---

1. Call `fetch_github_pr` to inspect the PR title, description, changed files, and patch diff.
2. Prioritize findings by impact:
   - `[P0]`: Security vulnerability, data loss, or broken production path.
   - `[P1]`: Logic bug, race condition, silent error swallowing, or missing validation.
   - `[P2]`: Edge case, performance regression, or missing regression test.
   - `[P3]`: Small clarity or maintainability improvement.
3. For every finding, cite the exact file path, explain the failure scenario, and provide a concrete fix.
4. End with `Verdict: approve` (no P0/P1) or `Verdict: request changes` (any P0/P1).
