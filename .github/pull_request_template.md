<!--
Labels come from the branch prefix and reviewers from CODEOWNERS — both automatic.
Still yours: the assignee (`gh pr create --assignee @me`) and the issue link below.
-->

## Summary

<!-- What changed, and why? -->
<!-- Add `Closes #<issue>` here when one exists — that is what carries Projects/Milestone/Priority over. -->

## Validation

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Added or updated the smallest relevant tests

## Checklist

- [ ] Assignee is set, and the branch uses a prefix so the labeler can label it
- [ ] Public-facing text is in English
- [ ] Errors fail visibly; no silent fallbacks or swallowed exceptions
- [ ] No secrets, local paths, or machine-specific state were committed
- [ ] No process-only notes were added (`*_PLAN.md`, `HANDOFF.md`, session notes, etc.)
- [ ] Docs were updated when behavior or public APIs changed
