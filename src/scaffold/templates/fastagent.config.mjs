// fastagent.config.mjs — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity and behavior live in AGENTS.md + skills/ + tools/, never here.
// Model precedence: `--model` flag > FASTAGENT_MODEL env > this default.
// Change "model" to a "provider/modelId" you have access to (`fastagent models` lists them).
export default {
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
};
