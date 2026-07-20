// fastagent.config.mjs — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity lives in persona.md; its capabilities in skills/ + tools/ — never here.
// An AGENTS.md at the workspace root (yours or the host repo's) is read as project context.
// Model precedence: `--model` flag > FASTAGENT_MODEL env > this default.
// No model is preset: `fastagent dev` shows the full model catalog (models you already have
// credentials for come first; picking one that needs auth logs you in inline) and writes your choice
// below. Or set it by hand to a "provider/modelId" (`fastagent models` lists them).
export default {
  // model: "openai-codex/gpt-5.5",
  // thinkingLevel: "high", // reasoning effort (off|minimal|low|medium|high|xhigh|max); default "medium" (pi TUI parity)
  http: { port: 8787 },
  // selfSchedule: true, // mount the built-in `wake` tool: the agent schedules its own follow-up turns
  // sessionControl: true, // serve /control/* for remote observation + steering (fastagent attach / Web panel)
  //                     // ("check the deploy in 10 min"). Cron jobs need no opt-in — drop a schedules/<name>.ts.
  // deploy: what the agent needs on the box (so `fastagent deploy` doesn't need a hand-written Dockerfile
  // or hand-set host variables). Uncomment as needed:
  // deploy: {
  //   secrets: ["GH_TOKEN"], // extra secret env vars your tools use — deploy carries them from your local env
  //   apt: ["git"],          // extra apt packages baked into the image (git, ripgrep, …; default repos only)
  // },
};
