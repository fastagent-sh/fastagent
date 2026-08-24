// fastagent.config.mjs — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity lives in persona.md; its capabilities in skills/ + tools/ — never here.
// An AGENTS.md in the WORKSPACE (the directory the agent is started in) is read as project context.
// Model precedence: `--model` flag > FASTAGENT_MODEL env > this default.
// No model is preset: `fastagent dev` shows the full model catalog (models you already have
// credentials for come first; picking one that needs auth logs you in inline) and writes your choice
// below. Or set it by hand to a "provider/modelId" (`fastagent models` lists them).
// Self-hosted model (vLLM/Ollama/…) or your own gateway? Declare it in a models.json next to this
// file and select it like any other spec — see docs/configuration.md "Custom model endpoints".
export default {
  // model: "openai-codex/gpt-5.5",
  // thinkingLevel: "high", // reasoning effort (off|minimal|low|medium|high|xhigh|max); default "medium" (pi TUI parity)
  // codingTools: false,    // read + search only; no bash/edit/write (read/grep/find/ls always mount)
  // codingTools: ["edit"], // ...or just the one you want
  http: { port: 8787 },
  // selfSchedule: true, // mount the built-in `wake` tool: the agent schedules its own follow-up turns
  //                     // ("check the deploy in 10 min"). Cron jobs need no opt-in — drop a schedules/<name>.ts.
  // sessionControl: true, // serve /control/* for remote observation + steering (fastagent attach / Web panel)
  // deploy: what the agent needs on the box (so `fastagent deploy` doesn't need a hand-written Dockerfile
  // or hand-set host variables). Uncomment as needed:
  // deploy: {
  //   secrets: ["GH_TOKEN"], // extra secret env vars your tools use — deploy carries them from your local env
  //   apt: ["git"],          // extra apt packages baked into the image (git, ripgrep, …; default repos only)
  // },
};
