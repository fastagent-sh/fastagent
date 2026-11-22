import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  // Set your preferred model once logged in (run `fastagent models` to list options):
  // model: "openai/gpt-5.5",
  codingTools: false,
  starters: [
    "Check the status of order ORD-9231",
    "Can I get a refund for order ORD-4410?",
  ],
});
