import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";
import { openSource } from "./open-source.ts";

export const roots: string[] = [];

export const agents: LocalAgent[] = [];

const NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

export const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

export async function directory(config: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-agent-"));
  roots.push(dir);
  await symlink(NODE_MODULES, join(dir, "node_modules"), "dir");
  await writeFile(join(dir, "package.json"), '{"type":"module","dependencies":{"@fastagent-sh/fastagent":"*"}}');
  await writeFile(join(dir, "context.json"), JSON.stringify(config));
  await writeFile(join(dir, "SYSTEM.md"), "Use the requested tool.");
  await writeFile(
    join(dir, "fastagent.config.ts"),
    `import { createFauxCore, createModels, createProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const core=createFauxCore({provider:"fixture",api:"fixture"});
const stream=(...args)=>{core.appendResponses([context=>{
 const last=context.messages.at(-1);
 if(last.role==="toolResult")return fauxAssistantMessage(last.content.filter(p=>p.type==="text").map(p=>p.text).join(""));
 const user=context.messages.findLast(m=>m.role==="user");const raw=typeof user.content==="string"?user.content:user.content.map(p=>p.text??"").join("");
 const cmd=JSON.parse(raw);return fauxAssistantMessage([fauxToolCall(cmd.name,cmd.args)],{stopReason:"toolUse"});
}]);return core.streamSimple(...args);};
export default {defaults:{model:"fixture/"+core.getModel().id},providers:[createProvider({id:"fixture",auth:{apiKey:{name:"fixture",resolve:async()=>({auth:{}})}},models:core.models,api:{stream,streamSimple:stream}})]};`,
  );
  return dir;
}

export async function opened(dir: string, options: Parameters<typeof openSource>[1]) {
  const agent = await openSource(dir, options);
  agents.push(agent);
  return agent;
}

export async function ask(agent: LocalAgent, name: string, args: Record<string, unknown> = {}, sessionId?: string) {
  const id = sessionId ?? (await agent.sessions.create()).id;
  return agent.messages.send({ sessionId: id, content: JSON.stringify({ name, args }) }, { wait: 10 });
}
