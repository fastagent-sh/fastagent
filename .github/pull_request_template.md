<!--
Labels come from the branch prefix and reviewers from CODEOWNERS — both automatic.
Still yours: the issue link below, and the assignee if you have push access (`gh pr create --assignee @me`).
-->

## Summary

<!-- What changed, and why? -->
<!-- Add `Closes #<issue>` here when one exists — it closes the issue on merge. Board fields stay manual. -->

## Validation

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Added or updated the smallest relevant tests

## Checklist

- [ ] The PR carries a label — from the branch prefix, or added by hand
- [ ] Public-facing text is in English
- [ ] Errors fail visibly; no silent fallbacks or swallowed exceptions
- [ ] No secrets, local paths, or machine-specific state were committed
- [ ] No process-only notes were added (`*_PLAN.md`, `HANDOFF.md`, session notes, etc.)
- [ ] Docs were updated when behavior or public APIs changed
