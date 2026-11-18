/**
 * An agent on a live AgentCore runtime, called as a Caller calls it (`connectAgentCore`, this machine's AWS
 * credentials): what no test on this machine can show. The runtime serves `fastagent agentcore serve` with its instances in
 * Aurora DSQL, and was made with a short idle timeout. A session answers through invocations, streams, keeps a refusal's
 * code, goes on after AgentCore reclaims its microVM (the conversation is in the database, not the microVM), and keeps
 * to itself. Outside the test suite, which leaves no test a way off the machine: run by hand when the
 * runtime or its Caller changes.
 *
 *   node --conditions=@fastagent-sh/source test/smoke/agentcore/live.ts <runtime ARN> <idle timeout seconds>
 */
import assert from "node:assert/strict";
import { connectAgentCore } from "../../../packages/agentcore/src/client.ts";

const [runtimeArn, idle] = process.argv.slice(2);
if (runtimeArn === undefined || idle === undefined) {
  throw new Error("usage: node test/smoke/agentcore/live.ts <runtime ARN> <idle timeout seconds>");
}

async function step(what: string, run: () => Promise<void>): Promise<void> {
  const started = performance.now();
  await run();
  console.error(`ok  ${what} (${((performance.now() - started) / 1000).toFixed(1)}s)`);
}

const sessionId = `live-${crypto.randomUUID()}`;
const agent = connectAgentCore({ runtimeArn, sessionId });
let conversation = "";

await step("a new session answers, as the instance it names", async () => {
  assert.equal((await agent.info()).name, sessionId);
  conversation = (await agent.sessions.create()).id;
  const answered = await agent.messages.send({ sessionId: conversation, content: "one" }, { wait: 60 });
  assert.deepEqual([answered.status, answered.answer?.text], ["completed", "seen 1"]);
});

await step("an answer streams", async () => {
  const events: string[] = [];
  for await (const event of agent.messages.stream({ sessionId: conversation, content: "two" })) events.push(event.type);
  assert.equal(events.at(-1), "done");
});

await step("a refusal keeps its status and code", async () => {
  await assert.rejects(agent.sessions.get("no-such-session"), { code: "not_found" });
});

await step(`the conversation goes on after AgentCore reclaims the idle microVM (${idle}s)`, async () => {
  await new Promise((resolve) => setTimeout(resolve, (Number(idle) + 60) * 1000));
  const answered = await agent.messages.send({ sessionId: conversation, content: "three" }, { wait: 60 });
  assert.deepEqual([answered.status, answered.answer?.text], ["completed", "seen 3"]);
});

await step("another session is another instance, with nothing of the first", async () => {
  const other = connectAgentCore({ runtimeArn, sessionId: `live-${crypto.randomUUID()}` });
  assert.deepEqual((await other.sessions.list()).data, []);
});

console.error(`ok  all on ${runtimeArn}`);
