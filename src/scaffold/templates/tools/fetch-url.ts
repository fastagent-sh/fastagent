import { defineTool, z } from "@kid7st/fastagent";

// A code tool: filename (fetch-url.ts) is the tool name. tools/ is auto-discovered,
// so it needs no registration in fastagent.config. Test it without a model:
//   fastagent tool fetch-url '{"url":"https://example.com"}'
// Serving this behind a public channel? The URL then comes from untrusted users — add an
// allowlist or block private-network addresses (localhost, 169.254.169.254, …) to prevent SSRF.
const MAX_TEXT = 20_000; // keep a huge page from flooding the model's context

export default defineTool({
  description: "Fetch a web page and return its readable text (HTML stripped, truncated).",
  input: z.object({ url: z.url({ protocol: /^https?$/ }).describe("The http(s) URL to fetch") }),
  async execute({ url }) {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    const html = await res.text();
    // ponytail: naive tag strip — fine for articles and docs; swap in a readability library if it falls short.
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
    const text = html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => entities[e] ?? " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url: res.url, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
  },
});
