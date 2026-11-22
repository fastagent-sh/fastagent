import { defineTool, needs } from "@fastagent-sh/fastagent";

const MAX_DIFF_CHARS = 60_000;

export default needs(
  [{ name: "GITHUB_TOKEN", description: "GitHub token for private repos and higher API rate limits", optional: true }],
  ({ GITHUB_TOKEN }) =>
    defineTool({
      name: "fetch_github_pr",
      description: "Fetch a GitHub pull request's metadata and unified diff.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner, e.g. fastagent-sh" },
          repo: { type: "string", description: "Repository name, e.g. fastagent" },
          pullNumber: { type: "integer", minimum: 1, description: "Pull request number" },
        },
        required: ["owner", "repo", "pullNumber"],
      } as const,
      execute: async ({ owner, repo, pullNumber }) => {
        const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`;
        const authHeaders: Record<string, string> = {
          "user-agent": "fastagent-pr-review",
          ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
        };

        const [metaRes, diffRes] = await Promise.all([
          fetch(base, { headers: { ...authHeaders, accept: "application/vnd.github+json" } }),
          fetch(base, { headers: { ...authHeaders, accept: "application/vnd.github.v3.diff" } }),
        ]);

        if (!metaRes.ok) {
          return JSON.stringify({ error: `GitHub API returned HTTP ${metaRes.status} for ${owner}/${repo}#${pullNumber}` });
        }

        const pr = (await metaRes.json()) as {
          title?: string;
          body?: string | null;
          state?: string;
          head?: { sha?: string; ref?: string };
          base?: { ref?: string };
          changed_files?: number;
          additions?: number;
          deletions?: number;
        };
        const rawDiff = diffRes.ok ? await diffRes.text() : "";
        const truncated = rawDiff.length > MAX_DIFF_CHARS;

        return JSON.stringify({
          title: pr.title,
          state: pr.state,
          base: pr.base?.ref,
          head: pr.head?.ref,
          headSha: pr.head?.sha,
          changedFiles: pr.changed_files,
          additions: pr.additions,
          deletions: pr.deletions,
          body: (pr.body ?? "").slice(0, 4_000),
          diff: truncated ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]` : rawDiff,
        });
      },
    }),
);
