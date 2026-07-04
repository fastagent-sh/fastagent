import { Type } from "@earendil-works/pi-ai";
import { defineConfig } from "../../../src/index.ts";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  http: { port: 9999 },
  tools: [
    {
      name: "ping",
      label: "Ping",
      description: "Reply pong.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "pong" }], details: {} };
      },
    },
  ],
});
