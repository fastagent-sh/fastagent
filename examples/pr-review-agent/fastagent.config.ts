import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  // Run `fastagent models` to pick a model, or pass `--model provider/modelId`.
  // model: "anthropic/claude-sonnet-4-6",
  harness: "dsh",
  // Kernel-enforced read-only OS sandbox: bash and read cannot modify files outside or inside the workspace.
  sandbox: "read-only",
  codingTools: ["read", "bash"],
  starters: [
    "Review pull request #1140 in fastagent-sh/fastagent",
    "Audit the security and error handling of the latest PR",
  ],
});
