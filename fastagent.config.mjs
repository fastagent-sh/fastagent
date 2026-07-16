// fastagent.config.mjs — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity lives in persona.md; its capabilities in skills/ + tools/ — never here.
// An AGENTS.md at the workspace root (yours or the host repo's) is read as project context.
// Model precedence: `--model` flag > FASTAGENT_MODEL env > this default.
// No model is preset: `fastagent dev` prompts you to pick one from the providers you're logged into
// (run `fastagent login` first) and writes your choice below. Or set it by hand to a "provider/modelId"
// you have access to (`fastagent models` lists them).
export default {
  agentDir: "./agent", // the agent's own surface (persona.md / skills / tools / channels) lives there
  // model: "openai-codex/gpt-5.5",
  // thinkingLevel: "high", // reasoning effort (off|minimal|low|medium|high|xhigh|max); default "medium" (pi TUI parity)
  http: { port: 8787 },
  // selfSchedule: true, // mount the built-in `wake` tool: the agent schedules its own follow-up turns
  //                     // ("check the deploy in 10 min"). Cron jobs need no opt-in — drop a schedules/<name>.ts.
  // deploy: what the agent needs on the box (so `fastagent deploy` doesn't need a hand-written Dockerfile
  // or hand-set host variables). Uncomment as needed:
  // deploy: {
  //   secrets: ["GH_TOKEN"], // extra secret env vars your tools use — deploy carries them from your local env
  //   apt: ["git"],          // extra apt packages baked into the image (git, ripgrep, …; default repos only)
  // },
};
