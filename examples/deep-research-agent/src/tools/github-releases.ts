import { defineTool, needs } from "@fastagent-sh/fastagent";

export default needs(
  [{ name: "GITHUB_TOKEN", description: "Optional GitHub token for higher API rate limits", optional: true }],
  ({ GITHUB_TOKEN }) =>
    defineTool({
      name: "github_releases",
      description: "Fetch the latest published releases for a GitHub repository.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner, e.g. fastagent-sh" },
          repo: { type: "string", description: "Repository name, e.g. fastagent" },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Number of releases (default: 3)" },
        },
        required: ["owner", "repo"],
      } as const,
      execute: async ({ owner, repo, limit }) => {
        const count = limit ?? 3;
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${count}`;
        const res = await fetch(url, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "fastagent-deep-research",
            ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return JSON.stringify({ error: `GitHub API returned HTTP ${res.status}` });

        const releases = (await res.json()) as Array<{
          tag_name: string;
          name?: string | null;
          published_at?: string;
          html_url: string;
          body?: string | null;
        }>;

        return JSON.stringify(
          releases.map((r) => ({
            tag: r.tag_name,
            name: r.name ?? r.tag_name,
            publishedAt: r.published_at,
            url: r.html_url,
            notesPreview: (r.body ?? "").slice(0, 1_500),
          })),
        );
      },
    }),
);
