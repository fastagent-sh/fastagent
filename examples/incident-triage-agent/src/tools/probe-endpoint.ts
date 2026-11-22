import { defineTool } from "@fastagent-sh/fastagent";

export default defineTool({
  name: "probe_endpoint",
  description: "Perform an HTTP GET health probe against an HTTPS endpoint and report status, latency, and headers.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", pattern: "^https://\\S+$", description: "HTTPS URL to probe" },
    },
    required: ["url"],
  } as const,
  execute: async ({ url }) => {
    const started = performance.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "fastagent-incident-triage" },
      });
      const latencyMs = Math.round(performance.now() - started);
      const bodyPreview = (await res.text()).slice(0, 500);
      return JSON.stringify({
        ok: res.ok,
        status: res.status,
        latencyMs,
        contentType: res.headers.get("content-type"),
        bodyPreview,
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
