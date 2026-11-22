import { defineTool, needs } from "@fastagent-sh/fastagent";

export default needs(
  [{ name: "GITHUB_TOKEN", description: "GitHub token for private repos and higher API rate limits", optional: true }],
  ({ GITHUB_TOKEN }) =>
    defineTool({
      name: "recent_commits",
      description: "List the most recent commits on a GitHub repository branch to correlate with an incident.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "GitHub org or user" },
          repo: { type: "string", description: "Repository name" },
          branch: { type: "string", description: "Branch name (default: main)" },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Number of commits (default: 10)" },
        },
        required: ["owner", "repo"],
      } as const,
      execute: async ({ owner, repo, branch, limit }) => {
        const count = limit ?? 10;
        const shaParam = branch ? `&sha=${encodeURIComponent(branch)}` : "";
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${count}${shaParam}`;
        const res = await fetch(url, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "fastagent-incident-triage",
            ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          return JSON.stringify({ error: `GitHub API returned HTTP ${res.status}` });
        }
        const rows = (await res.json()) as Array<{
          sha: string;
          commit: { message: string; author?: { name?: string; date?: string } };
        }>;
        return JSON.stringify(
          rows.map((c) => ({
            sha: c.sha.slice(0, 8),
            date: c.commit.author?.date,
            author: c.commit.author?.name,
            subject: c.commit.message.split("\n")[0],
          })),
        );
      },
    }),
);
