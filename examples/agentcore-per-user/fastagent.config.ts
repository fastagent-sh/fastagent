import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  // Configure a model supported by your Secrets Manager secret (for Bedrock, set AWS_BEARER_TOKEN_BEDROCK).
  // model: "anthropic/claude-sonnet-4-6",
  // Disable shell/file tools when sharing one AgentCore execution role across multiple end users.
  codingTools: false,
  starters: [
    "Draft a weekly project update from my saved notes",
    "Capture three action items from today's design review",
  ],
});
