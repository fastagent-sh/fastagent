import { defineTool } from "@fastagent-sh/fastagent";

export default defineTool({
  name: "search_hacker_news",
  description: "Search recent Hacker News stories via the public Algolia HN Search API.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query, e.g. 'AI agent runtime' or 'MCP'" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Max stories to return (default: 8)" },
    },
    required: ["query"],
  } as const,
  execute: async ({ query, limit }) => {
    const count = limit ?? 8;
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=${count}&query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return JSON.stringify({ error: `HN API returned HTTP ${res.status}` });

    const data = (await res.json()) as {
      hits: Array<{
        objectID: string;
        title?: string;
        url?: string;
        points?: number;
        num_comments?: number;
        created_at?: string;
      }>;
    };

    return JSON.stringify(
      data.hits.map((h) => ({
        title: h.title,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points ?? 0,
        comments: h.num_comments ?? 0,
        createdAt: h.created_at,
      })),
    );
  },
});
