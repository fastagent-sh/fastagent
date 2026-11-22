import { isIP } from "node:net";
import { defineTool, needs } from "@fastagent-sh/fastagent";

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) return true;
  if (isIP(lower)) {
    return (
      lower === "::1" ||
      lower.startsWith("127.") ||
      lower.startsWith("10.") ||
      lower.startsWith("169.254.") ||
      lower.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(lower) ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:")
    );
  }
  return false;
}

export default needs(
  [{ name: "PROBE_ALLOWED_HOSTS", description: "Comma-separated hostnames allowed for probe_endpoint", optional: true }],
  ({ PROBE_ALLOWED_HOSTS }) => {
    const allowed = new Set(
      (PROBE_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
    return defineTool({
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
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return JSON.stringify({ ok: false, error: "Invalid URL" });
        }
        if (parsed.protocol !== "https:") {
          return JSON.stringify({ ok: false, error: "Only https:// URLs are allowed" });
        }
        const host = parsed.hostname.toLowerCase();
        if (allowed.size > 0 ? !allowed.has(host) : isBlockedHost(host)) {
          return JSON.stringify({ ok: false, error: `Host "${parsed.hostname}" is not permitted for probing` });
        }

        const started = performance.now();
        try {
          const res = await fetch(parsed, {
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
  },
);
