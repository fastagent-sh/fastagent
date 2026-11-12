import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TranscriptContext, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

// Under test/fixtures, so the agent's modules resolve this repository's packages and its src/ by a fixed depth.
const ROOT = join(import.meta.dirname, "fixtures");

export const made: string[] = [];

const DEFINE = "../../../../../src/harnesses/pi-durable/define.ts";

/** An agent package with `files`, its directory under test/fixtures. */
export function agentPackage(files: Record<string, string>): string {
  const dir = join(ROOT, `.tmp-${process.pid}-${made.length}`);
  made.push(dir);
  for (const [file, text] of Object.entries({ "package.json": '{ "name": "support", "type": "module" }', ...files })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** A model scripted through a module both the agent's configuration and the test import: one instance, by URL. */
const MODEL_MODULE = `import { fauxProvider } from "@earendil-works/pi-ai";
export const faux = fauxProvider({ provider: "fixture", models: [{ id: "m" }] });
`;

export const FILES: Record<string, string> = {
  "model.ts": MODEL_MODULE,
  "fastagent.config.ts": `import { faux } from "./model.ts";
export default { defaults: { model: "fixture/m", thinkingLevel: "low" }, providers: [faux.provider] };
`,
  "SYSTEM.md": "You are Support.\n",
  "AGENTS.md": "Be brief.\n",
  "skills/lookup-order/SKILL.md": `---
name: lookup-order
description: Look an order up. Use when a customer names an order.
---
Ask for the order number, then read references/codes.md.
`,
  "skills/Not_Valid/SKILL.md": "---\nname: Not_Valid\ndescription: broken\n---\nbody\n",
  "prompts/review.md": "---\ndescription: Review something\n---\nReview $1 carefully. Everything: $@\n",
  "src/tools/weather.ts": `import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { needs } from "${DEFINE}";
export default needs(
  [{ name: "WEATHER_KEY", description: "The weather service's API key" }, { name: "WEATHER_REGION", optional: true }],
  ({ WEATHER_KEY, WEATHER_REGION }) =>
    defineTool({
      name: "weather",
      description: "Tells the weather",
      parameters: obj({ city: str() }),
      execute: async (args) => ({
        output: [{ type: "text", text: \`\${args.city}: sunny (key \${WEATHER_KEY}, region \${WEATHER_REGION ?? "none"})\` }],
      }),
    }),
);
`,
  "src/tools/weather.test.ts": "throw new Error('a test file is not a module');\n",
  "src/extensions/audit.ts": `import { defineExtension, section } from "@earendil-works/pi-durable";
export default defineExtension({ name: "audit", sections: [section("audit", () => "Every answer is audited.")] });
`,
  "src/schedules/daily.ts": `import { defineSchedule } from "${DEFINE}";
export default defineSchedule({ cron: "0 9 * * *", tz: "Europe/London", prompt: ({ at }) => \`Report for \${at.toISOString()}\` });
`,
  "context.json": JSON.stringify({ environment: { variables: { GH_TOKEN: { description: "For gh" } } } }),
};

export const ENV = { WEATHER_KEY: "k-123", GH_TOKEN: "gh" };

export const toolCall = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

export function lastToolResult(context: TranscriptContext): string {
  const result = context.messages.at(-1);
  if (result?.role !== "toolResult") throw new Error("the model was not answering a tool call");
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
