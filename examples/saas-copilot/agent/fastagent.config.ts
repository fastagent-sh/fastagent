import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  // Run `fastagent models` or pass `FASTAGENT_MODEL` in the host server.
  // model: "openai/gpt-5.5",
  // Mandatory for multi-tenant embedded hosting: disables read/write/edit/bash.
  codingTools: false,
  starters: [
    "Summarize my workspace usage and plan limits",
    "Explain why our webhook delivery rate dropped this week",
  ],
});
