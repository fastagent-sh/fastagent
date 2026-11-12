import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "fixtures");

export const made: string[] = [];

export function project(files: Record<string, string>): string {
  const dir = join(ROOT, `.tmp-build-${process.pid}-${made.length}`);
  made.push(dir);
  const all = {
    "package.json": JSON.stringify({
      name: "@acme/support",
      version: "1.2.0",
      description: "Answers support questions.",
      type: "module",
      dependencies: { "@fastagent-sh/fastagent": "^0.29.0", "@earendil-works/pi-durable": "1.5.0", lodash: "^4" },
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const TOOL = `import { readFileSync } from "node:fs";
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { shout } from "../../lib/shout.ts";
import data from "./lookup/data.json" with { type: "json" };
const note = readFileSync(new URL("./lookup/note.txt", import.meta.url), "utf8").trim();
export default defineTool({
  name: "lookup",
  description: "Look something up.",
  parameters: obj({ text: str() }),
  execute: async ({ text }) => ({ output: [{ type: "text", text: [shout(text), data.unit, note].join(" ") }] }),
});
`;

export const FILES: Record<string, string> = {
  "fastagent.config.ts": 'export default { defaults: { model: "openai/gpt-6.1-sol" } };\n',
  "SYSTEM.md": "You are Support.\n",
  "AGENTS.md": "Be brief.\n",
  LICENSE: "MIT\n",
  "context.json": JSON.stringify({ environment: { variables: { LOOKUP_KEY: { description: "the lookup service" } } } }),
  "skills/lookup/SKILL.md": "---\nname: lookup\ndescription: Look up\n---\nUse lookup.\n",
  "skills/lookup/.env": "SKILL_TOKEN=leaked\n",
  "prompts/review.md": "Review $1.\n",
  "lib/shout.ts": "export const shout = (text: string): string => text.toUpperCase();\n",
  "src/tools/lookup.ts": TOOL,
  "src/tools/lookup/data.json": '{ "unit": "kg" }\n',
  "src/tools/lookup/note.txt": "from the note\n",
  "src/tools/lookup.test.ts": "throw new Error('a test is not a module');\n",
  ".secrets/.env": "LOOKUP_KEY=secret\n",
  ".state/agent.sqlite": "state\n",
  "content/repo/README.md": "a clone\n",
};

export const listing = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
