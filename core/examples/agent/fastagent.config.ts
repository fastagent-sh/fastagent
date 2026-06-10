/**
 * fastagent.config.ts — deployment/assembly choices (in git; secrets in .env).
 * Agent identity & behavior do NOT live here (they live in AGENTS.md + skills/).
 *
 * Run: node ../../src/cli.ts dev .   (real users: fastagent dev)
 */
import { defineConfig } from "../../src/index.ts"; // real users: from "@fastagent/core"
import lookupOrderTool from "./lookup-order-tool.ts";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  tools: [lookupOrderTool], // appended after pi default tools (read/bash/edit/write)
  http: { port: 8787 },
});
