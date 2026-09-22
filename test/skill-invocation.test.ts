/**
 * RUNNING a listed command, over the data plane (docs/design/session-control.md §5.1.1).
 *
 * `commands()` publishes names; this is what sending one back means. The whole reason it is the ENGINE's job and
 * not a client's: the expansion reads the definition's own files, so it works the same for an in-process caller
 * and for one holding nothing but an HTTP connection. A client that reconstructed the prompt from
 * `skills/<name>/SKILL.md` would be re-implementing definition loading AND would break against a remote agent,
 * which is the one case local/remote symmetry exists to protect.
 *
 * Behaviour under test belongs to pi's `AgentSession.prompt()`, which fastagent reaches by NOT passing
 * `expandPromptTemplates: false` (src/engines/pi/turn-kit.ts, `toPiPromptOptions`). Both halves of that sentence
 * can regress without a word changing here — an engine upgrade, or one added option — so the assertion is on the
 * bytes the model receives.
 */
import { expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Agent } from "../src/agent.ts";
import { collect } from "../src/collect.ts";
import { piAgentSessionFactory } from "../src/engines/pi/agent-session-factory.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import { inProcessLease } from "../src/engines/pi/turn-kit.ts";
import { makeFaux } from "./faux.ts";

/** An agent over one real skill on disk, plus the user text each turn actually sent to the model. */
async function agentWithSkill(): Promise<{ agent: Agent; sent: () => string }> {
  const dir = await mkdtemp(join(tmpdir(), "fa-skill-invoke-"));
  await mkdir(join(dir, "skills", "weather"), { recursive: true });
  const filePath = join(dir, "skills", "weather", "SKILL.md");
  await writeFile(filePath, "---\nname: weather\ndescription: Report weather.\n---\nCall the METAR endpoint.\n");

  const { faux } = makeFaux();
  const seen: string[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context: { messages: { role: string }[] }) => {
      seen.push(JSON.stringify(context.messages.filter((message) => message.role === "user")));
      return fauxAssistantMessage("ok");
    }),
  );
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const agent = createPiAgentFromSession({
    lease: inProcessLease(),
    sessionFactory: piAgentSessionFactory({
      sessions: piInMemorySessionRecordStore({ cwd: dir }),
      engine: async () => ({ modelRuntime, model: faux.getModel() }),
      // The same definition read `commands()` answers from: names resolved, collisions already decided.
      readDefinition: () => ({
        systemPrompt: "test",
        // `content` is deliberately NOT the body: the expansion reads `filePath` at prompt time, which is what
        // makes a definition edited while serving take effect on the next turn.
        skills: [{ name: "weather", description: "Report weather.", filePath, content: "STALE-IN-MEMORY-COPY" }],
      }),
      cwd: dir,
    }),
  });
  return { agent, sent: () => seen.at(-1) ?? "" };
}

it("`/skill:<name>` arrives as the skill's BODY, with the arguments after it", async () => {
  const { agent, sent } = await agentWithSkill();
  await collect(agent.invoke({ session: "s" }, { text: "/skill:weather in Berlin" }));

  // The engine read the file and sent its contents; the client sent 23 characters.
  expect(sent()).toContain("Call the METAR endpoint.");
  expect(sent()).not.toContain("STALE-IN-MEMORY-COPY"); // read from the file, per turn
  expect(sent()).toContain('<skill name=\\"weather\\"');
  expect(sent()).toContain("in Berlin");
});

it("a BARE name is ordinary text — the prefix is what makes it deterministic", async () => {
  // Typing `/weather` reaches the model unchanged, which is why the model "usually reads the skill" rather than
  // always. A client that wants the deterministic path sends the prefixed spelling.
  const { agent, sent } = await agentWithSkill();
  await collect(agent.invoke({ session: "s" }, { text: "/weather in Berlin" }));

  expect(sent()).toContain("/weather in Berlin");
  expect(sent()).not.toContain("Call the METAR endpoint.");
});

it("an unknown name goes through as plain text, silently", async () => {
  // The fall-back a client has to know about: nothing rejects, nothing warns, and the model is asked to make
  // sense of a line the author meant as a command. Checking the name against `commands()` first is the client's
  // job precisely because this layer cannot tell a typo from a sentence that starts with a slash.
  const { agent, sent } = await agentWithSkill();
  await collect(agent.invoke({ session: "s" }, { text: "/skill:wether in Berlin" }));

  expect(sent()).toContain("/skill:wether in Berlin");
  expect(sent()).not.toContain("Call the METAR endpoint.");
});
