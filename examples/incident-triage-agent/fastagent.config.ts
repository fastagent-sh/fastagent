import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  // Run `fastagent models` to pick a model, or pass `--model provider/modelId`.
  // model: "anthropic/claude-sonnet-4-6",
  // Tool-only posture: disable built-in shell/file tools for untrusted alert payloads.
  codingTools: false,
  starters: [
    "Triage a 503 spike on https://api.example.com/health and check recent commits in myorg/api",
    "Summarize the active incident and draft a customer status update",
  ],
  // Optionally connect external observability or issue-tracker MCP servers:
  // mcpServers: {
  //   sentry: {
  //     type: "http",
  //     url: "https://mcp.sentry.example.com/mcp",
  //     headers: { Authorization: "Bearer ${SENTRY_MCP_TOKEN}" },
  //   },
  // },
});
