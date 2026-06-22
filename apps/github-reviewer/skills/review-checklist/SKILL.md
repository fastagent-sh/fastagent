---
name: review-checklist
description: What to look for when reviewing a pull request, and the exact `gh` commands to post the review. Consult before forming review conclusions and before posting.
---
# Review checklist

Read the change in context first (`gh pr diff <number> --repo <owner/repo>`, then open the touched
files — clone on demand if needed). Then check, in priority order:

## Correctness & safety (block on these)
- Logic errors: off-by-one, wrong operator, inverted condition, wrong variable.
- Error handling: swallowed errors, ignored return values, `catch` that hides failures,
  `?? default` masking a real error.
- Concurrency: races, unguarded shared state, missing locks/idempotency, lost updates.
- Resources: unclosed handles/connections, leaks, unbounded growth.
- Security: injection (shell/SQL/path), unvalidated input, secrets in code/logs, missing
  authz checks, SSRF.
- Data loss: destructive ops without guards, migrations that drop/rewrite data.
- Contract/API misuse: wrong call shape, broken backward compatibility, violated invariants.
- Edge cases: empty/null, large input, timeout, partial failure, retries.

## Worth raising (comment, don't block)
- Tests missing for the new behavior or the bug being fixed.
- Unclear naming or a comment that contradicts the code.
- Duplicated logic that already exists elsewhere.

## Do not comment on
- Formatting, import order, quote style — linters own these.
- Personal-preference rewrites with no correctness or clarity gain.

## Posting the review with `gh`

Post a **single review** with a summary body and inline line comments. Build the payload as
JSON (use your `write` tool), then submit it with `gh api --input`:

1. Write `review.json`:
   ```json
   {
     "event": "COMMENT",
     "body": "Summary: 2 correctness issues, otherwise solid.",
     "comments": [
       { "path": "src/auth.ts", "line": 42, "body": "Token never refreshed: an expired token fails every request after the first hour. Refresh before use." },
       { "path": "src/queue.ts", "line": 88, "side": "RIGHT", "body": "(optional) This retry has no cap and can spin forever on a permanent failure." }
     ]
   }
   ```
   - `path` is repo-relative; `line` is the line in the PR's diff (the new file unless you set
     `"side": "LEFT"`). Only comment on lines that appear in the diff.
   - `event`: `COMMENT` for feedback, `APPROVE` when the change is sound, `REQUEST_CHANGES`
     for blocking issues.

2. Submit:
   ```bash
   gh api repos/<owner>/<repo>/pulls/<number>/reviews --input review.json
   ```

If you have only a summary and no line-specific comments, the simplest path is:
```bash
gh pr review <number> --repo <owner/repo> --comment --body "…"   # or --approve / --request-changes
```
