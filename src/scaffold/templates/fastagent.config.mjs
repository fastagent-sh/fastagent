// fastagent.config.mjs — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity and behavior live in AGENTS.md + skills/ + tools/, never here.
// Model precedence: `--model` flag > FASTAGENT_MODEL env > this default.
// No model is preset: `fastagent dev` prompts you to pick one from the providers you're logged into
// (run `fastagent login` first) and writes your choice below. Or set it by hand to a "provider/modelId"
// you have access to (`fastagent models` lists them).
export default {
  // model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
  // deploy: what the agent needs on the box (so `fastagent deploy` doesn't need a hand-written Dockerfile
  // or hand-set host variables). Uncomment as needed:
  // deploy: {
  //   secrets: ["GH_TOKEN"], // extra secret env vars your tools use — deploy carries them from your local env
  //   apt: ["git"],          // extra apt packages baked into the image (git, ripgrep, …; default repos only)
  // },
};
