import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  // Run `fastagent models` to pick a model, or pass `--model provider/modelId`.
  // model: "anthropic/claude-sonnet-4-6",
  // Allow reading and writing Markdown reports inside the instance workspace, without bash.
  codingTools: ["read", "write"],
  starters: [
    "/daily-brief",
    "Compare recent releases and Hacker News sentiment around MCP and AI agent runtimes",
  ],
});
