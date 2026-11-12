import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { type AgentDefinition, defineDefinition } from "../src/harnesses/pi-durable/definition.ts";
import { openAgent } from "../src/harnesses/pi-durable/serve.ts";

export const made: string[] = [];

export const SETTINGS = obj({ repo: str(), digestChannel: opt(str()), retries: opt(int({ minimum: 0 })) });

export const program = (config: object) =>
  defineDefinition({
    format: 1,
    builtWith: "0.0.0",
    name: "reviewer",
    version: "1.0.0",
    dir: "/program",
    config,
    registry: { tools: [], extensions: [], channels: [], schedules: [] },
  });

export const reviewer = program({
  settings: SETTINGS,
  defaults: {
    model: "openai/gpt-5.5",
    thinkingLevel: "high",
    http: { port: 8787, api: true },
    settings: { digestChannel: "#general" },
  },
});

export const instance = (values: unknown) => ({ values, label: "fastagent.json" });

// Checked by `tsc`, which runs over the tests: a definition typed by its settings types an embedder's `config`.
declare const typed: AgentDefinition<{ repo: string; digestChannel?: string }>;

export const typedSettings = () => [
  openAgent(typed, { root: "/instance", config: { settings: { repo: "acme/api" } } }),
  // @ts-expect-error a setting the program does not declare
  openAgent(typed, { root: "/instance", config: { settings: { repoo: "acme/api" } } }),
  // @ts-expect-error a setting of the wrong type
  openAgent(typed, { root: "/instance", config: { settings: { repo: 7 } } }),
];
