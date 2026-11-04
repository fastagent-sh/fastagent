/**
 * A package built from a project and installed under an app's `node_modules`, as an app's install leaves it: the
 * definition a test opens as instances. Its model does what a message says (`{ "name": <tool>, "args": {...} }`).
 */
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";

export const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

const PROBE_CONFIG = `// @ts-nocheck
import { createFauxCore, createProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const core = createFauxCore({ provider: "fixture", api: "fixture" });
const stream = (...args) => {
  core.appendResponses([(context) => {
    const last = context.messages.at(-1);
    if (last.role === "toolResult") return fauxAssistantMessage(last.content.filter((p) => p.type === "text").map((p) => p.text).join(""));
    const user = context.messages.findLast((m) => m.role === "user");
    const raw = typeof user.content === "string" ? user.content : user.content.map((p) => p.text ?? "").join("");
    const command = JSON.parse(raw);
    return fauxAssistantMessage([fauxToolCall(command.name, command.args)], { stopReason: "toolUse" });
  }]);
  return core.streamSimple(...args);
};
export default {
  defaults: { model: "fixture/" + core.getModel().id },
  providers: [createProvider({ id: "fixture", auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } }, models: core.models, api: { stream, streamSimple: stream } })],
};
`;

/** Build the project in `project` (made here, empty) and install its `dist/` as `@acme/probe` under `app`. */
export async function installProbe(project: string, app: string): Promise<string> {
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "@acme/probe", version: "1.0.0", type: "module" }),
  );
  writeFileSync(join(project, "fastagent.config.ts"), PROBE_CONFIG);
  writeFileSync(join(project, "SYSTEM.md"), "Do what the message says.\n");
  const { dist } = await buildProject(project);
  const location = join(app, "node_modules", "@acme", "probe");
  mkdirSync(location, { recursive: true });
  cpSync(dist, location, { recursive: true });
  // What an install of the app's dependencies brings: the FastAgent the package imports.
  mkdirSync(join(app, "node_modules", "@fastagent-sh"), { recursive: true });
  symlinkSync(join(FIXTURES, "fastagent-shim"), join(app, "node_modules", "@fastagent-sh", "fastagent"), "dir");
  return location;
}
