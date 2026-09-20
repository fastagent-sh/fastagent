// fastagent.config.ts — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity lives in persona.md; its capabilities in skills/ + tools/ — never here.
// An AGENTS.md in the WORKSPACE (the directory the agent is started in) is read as project context.
// Model precedence: `--model` flag > FASTAGENT_MODEL env > this default.
// No model is preset: `fastagent dev` shows the full model catalog (models you already have
// credentials for come first; picking one that needs auth logs you in inline) and writes your choice
// below. Or set it by hand to a "provider/modelId" (`fastagent models` lists them).
// Self-hosted model (vLLM/Ollama/…) or your own gateway? Declare it in a models.json next to this
// file and select it like any other spec — see docs/configuration.md "Custom model endpoints".
//
// `satisfies` is what makes your editor complete these keys and describe them on hover — and what
// turns a typo into an error you see while writing rather than one `fastagent dev` reports. The
// import is TYPE-only: nothing is loaded at runtime. Every key is optional; the commented lines
// below carry the default.
import type { FastagentConfig } from "@fastagent-sh/fastagent";

export default {
  // model: "openai-codex/gpt-5.5",
  // thinkingLevel: "high", // reasoning effort (off|minimal|low|medium|high|xhigh|max); default "medium" (pi TUI parity)
  // add `host: "127.0.0.1"` here to pin the bind address; default: `start` all interfaces (what containers
  // need), `dev` loopback. `cors: ["https://your-app.example.com"]` pins which origins a browser may call
  // this serve from. The default is `*` on every bind — any page your users visit can call this port and
  // read the reply, a loopback bind included (it stops another machine, not your own browser).
  // `invoke: false` withholds POST /invoke, for a serve meant to be reached only through its channels
  // (POST /trigger goes with it; `trigger: true` keeps it for an external clock firing your schedules).
  http: { port: 8787 },
  // selfSchedule: true, // mount the built-in `wake` tool: the agent schedules its own follow-up turns
  //                     // ("check the deploy in 10 min"). Cron jobs need no opt-in — drop a schedules/<name>.ts.
  // sessionControl: true, // serve /control/* for remote observation + steering (a Web panel, a desktop app)
  // tools: [], // programmatically defined tools, appended after the coding ones — tools/ is the usual way
  // deploy: what the agent needs on the box (so `fastagent deploy` doesn't need a hand-written Dockerfile
  // or hand-set host variables). Uncomment as needed:
  // deploy: {
  //   secrets: ["GH_TOKEN"], // extra secret env vars your tools use — deploy reads their values from .secrets/.env
  //   apt: ["git"],          // extra apt packages baked into the image (git, ripgrep, …; default repos only)
  //   agentcore: { idleTimeoutSeconds: 180 }, // `deploy agentcore` only: idle microVM tail, 60–1209600s
  // },
} satisfies FastagentConfig;
