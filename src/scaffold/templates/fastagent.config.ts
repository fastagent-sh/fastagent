// fastagent.config.ts — the agent's settings, the same wherever it runs. Its prompt lives in SYSTEM.md, its
// capabilities in skills/ and src/ (tools, extensions, channels, schedules) — never here. Its name and description are
// package.json's.
//
// Model precedence: `--model` flag > FASTAGENT_MODEL env > `model` here. No model is preset: `fastagent dev` shows the
// model catalog (models you already have credentials for come first; picking one that needs auth logs you in inline)
// and runs with your choice; set it below to keep it. `fastagent models` lists every "provider/modelId". A
// self-hosted model (vLLM, Ollama, …) or your own gateway is a provider in code: `providers: [...]`, built with
// pi-ai's `createProvider`.
//
// Every key is optional; the commented lines carry an example. `satisfies` is what makes your editor complete these
// keys and turns a typo into an error you see while writing. The import is TYPE-only: nothing is loaded at runtime,
// so the agent opens before `npm install` has run.
import type { AgentConfig } from "@fastagent-sh/fastagent";

export default {
  // model: "openai/gpt-5.5",
  // thinkingLevel: "high", // reasoning effort (off|minimal|low|medium|high|xhigh|max)
  // starters: ["What can you do?"], // example first messages a client may offer
} satisfies AgentConfig;
