// fastagent.config.ts — the agent's configuration: what it is, and what each instance of it starts with. Its prompt
// lives in SYSTEM.md, its capabilities in skills/ and src/ (tools, extensions, channels, schedules) — never here.
//
// Model precedence: `--model` flag > FASTAGENT_MODEL env > an instance's `fastagent.json` > this default. No model is
// preset: `fastagent dev` shows the model catalog (models you already have credentials for come first; picking one
// that needs auth logs you in inline) and runs with your choice; set it below to keep it. `fastagent models` lists
// every "provider/modelId". A self-hosted model (vLLM, Ollama, …) or your own gateway is a provider in code:
// `providers: [...]`, built with pi-ai's `createProvider`.
//
// Every key is optional; the commented lines carry an example. `satisfies` is what makes your editor complete these
// keys and turns a typo into an error you see while writing. The import is TYPE-only: nothing is loaded at runtime,
// so the agent opens before `npm install` has run. To let each instance choose values of its own, declare `settings`
// with `obj({ ... })` from @earendil-works/pi-schema and switch to `defineAgent`.
import type { AgentConfig } from "@fastagent-sh/fastagent";

export default {
  // Constants (what this agent is; an instance cannot change them): providers. Its name and description are package.json's.

  // Defaults: what an instance starts with, which its own `fastagent.json` may override.
  defaults: {
    // model: "openai/gpt-5.5",
    // thinkingLevel: "high", // reasoning effort (off|minimal|low|medium|high|xhigh|max)
    http: {
      port: 8787, // the port a serve listens on, for its channels' webhooks and its health check
      // api: false, // serve no Agent API under /v1, whatever key the environment holds; deploy gives none a key
    },
    // deploy: { agentcore: { idleTimeoutSeconds: 180 } }, // `deploy agentcore` only: idle microVM tail, 60–1209600s
  },
} satisfies AgentConfig;
