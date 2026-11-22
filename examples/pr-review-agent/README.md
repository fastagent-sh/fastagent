# Sandboxed PR Review Agent

A background code-review agent designed for GitHub Actions and CI webhooks:

- **Kernel-enforced read-only OS sandbox:** Configured with `harness: "dsh"` and `sandbox: "read-only"` so `bash` and `read` cannot mutate files.
- **Real GitHub PR fetching:** `src/tools/github-pr.ts` uses `defineTool` + `needs([{ name: "GITHUB_TOKEN", optional: true }])` to pull live PR metadata and diffs.
- **Persistent per-PR memory & idempotent retries:** `workflow.pr-review.yml` calls `POST /v1/invoke` with `conversation: "pr-<owner>-<repo>-<number>"` and `Idempotency-Key: pr-<number>-<headSha>`, so follow-up commits continue the same review thread and retries never double-comment.

## Run locally

```bash
npm install
npx @fastagent-sh/fastagent info
npx @fastagent-sh/fastagent invoke "Review PR #1140 in fastagent-sh/fastagent"
```

> Pass `--harness pi-durable` if you want to run without `@fastagent-sh/harness-dsh`.

## Deploy & wire to GitHub Actions

```bash
npx @fastagent-sh/fastagent deploy init fly
npx @fastagent-sh/fastagent deploy check
```

After deploying, set `FASTAGENT_URL` and `FASTAGENT_API_KEY` as GitHub repository secrets and copy [`workflow.pr-review.yml`](./workflow.pr-review.yml) into `.github/workflows/pr-review.yml`.
