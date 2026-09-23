/**
 * RUNNING a listed command, over the data plane (docs/design/session-control.md §5.1.1).
 *
 * `commands()` publishes names; this is what sending one back means. The whole reason it is the ENGINE's job and
 * not a client's: the expansion reads the definition's own files, so it works the same for an in-process caller
 * and for one holding nothing but an HTTP connection. A client that reconstructed the prompt from
 * `skills/<name>/SKILL.md` would be re-implementing definition loading AND would break against a remote agent,
 * which is the one case local/remote symmetry exists to protect.
 *
 * THE REAL ASSEMBLY, not a hand-built session: the behaviour needs two things to hold at once — pi's
 * `AgentSession.prompt()` expands the prefix, and fastagent hands it the definition's skills with a readable
 * `filePath` while never passing `expandPromptTemplates: false` (src/engines/pi/turn-kit.ts). Either half can
 * regress without a word changing in this file, so the assertion is on the bytes the model receives, through
 * `createPiAgentFromDefinition`.
 */
import { expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Agent } from "../src/agent.ts";
import { createInvokeHandler } from "../src/channels/http.ts";
import { collect, createPiAgentFromDefinition } from "../src/index.ts";
import { log } from "../src/log.ts";
import { piAgentSessionFactory } from "../src/engines/pi/agent-session-factory.ts";
import { createPiAgentFromSession } from "../src/engines/pi/invoke-session.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import { inProcessLease } from "../src/engines/pi/turn-kit.ts";
import { makeFaux } from "./faux.ts";

const SKILL = (body: string) => `---\nname: weather\ndescription: Report weather.\n---\n${body}\n`;

/** An agent over one real skill file, the path to that file, and the user text each turn sent to the model. */
async function agentWithSkill(): Promise<{ agent: Agent; skillPath: string; sent: () => string }> {
  const dir = await mkdtemp(join(tmpdir(), "fa-skill-invoke-"));
  await writeFile(join(dir, "persona.md"), "You are terse.\n");
  await mkdir(join(dir, "skills", "weather"), { recursive: true });
  const skillPath = join(dir, "skills", "weather", "SKILL.md");
  await writeFile(skillPath, SKILL("Call the METAR endpoint."));

  const { faux } = makeFaux();
  const seen: string[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context: { messages: { role: string }[] }) => {
      seen.push(JSON.stringify(context.messages.filter((message) => message.role === "user")));
      return fauxAssistantMessage("ok");
    }),
  );
  const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
  return { agent, skillPath, sent: () => seen.at(-1) ?? "" };
}

it("`/skill:<name>` arrives as the skill's BODY, re-read per turn, with the arguments after it", async () => {
  const { agent, skillPath, sent } = await agentWithSkill();
  await collect(agent.invoke({ session: "s" }, { text: "/skill:weather in Berlin" }));

  // The engine read the file and sent its contents; the client sent 23 characters.
  expect(sent()).toContain("Call the METAR endpoint.");
  expect(sent()).toContain('<skill name=\\"weather\\"');
  expect(sent()).toContain("in Berlin");

  // Per TURN, not per boot: the definition is live, so an edit while serving is the next turn's prompt.
  // A fresh session, because the old body is legitimately still in this one's history.
  await writeFile(skillPath, SKILL("Call the TAF endpoint instead."));
  await collect(agent.invoke({ session: "s2" }, { text: "/skill:weather in Berlin" }));
  expect(sent()).toContain("Call the TAF endpoint instead.");
  expect(sent()).not.toContain("Call the METAR endpoint.");
});

it("the same prompt over HTTP produces the same expansion — the point of putting it in the engine", async () => {
  // A remote client has no access to `skills/weather/SKILL.md`; it sends the spelling and nothing else. If this
  // ever diverged from the in-process path, every GUI would have to reimplement definition loading to compensate.
  const { agent, sent } = await agentWithSkill();
  const handler = createInvokeHandler(agent);
  const response = await handler(
    new Request("http://agent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "s", text: "/skill:weather in Berlin" }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text(); // drain the SSE stream so the turn completes

  expect(sent()).toContain("Call the METAR endpoint.");
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

it("a skill whose FILE went unreadable leaves the definition, loudly, and then reads as unknown", async () => {
  // The loader reads the file before anything can expand it, so there is no second silent fall-back to document:
  // an unreadable skill is simply not in this turn's definition. It warns with the errno and drops off
  // `commands()`, which is why the one list a client compares against covers a typo AND a skill that broke.
  const { agent, skillPath, sent } = await agentWithSkill();
  await chmod(skillPath, 0o000);
  // Captured, not read off the spy afterwards: `mockRestore()` clears `mock.calls` with it.
  const warned: string[] = [];
  const warn = vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));
  try {
    await collect(agent.invoke({ session: "s" }, { text: "/skill:weather now" }));
  } finally {
    await chmod(skillPath, 0o644);
    warn.mockRestore();
  }

  expect(warned.join("\n")).toMatch(/read_failed:.*(EACCES|permission denied)/);
  expect(sent()).toContain("/skill:weather now"); // unexpanded, like any name the definition does not have
});

it("an expansion that fails because the LIST outlived the file is reported, not swallowed", async () => {
  // The other order, and the one the loader cannot pre-empt: the skill list is refreshed per invoke, the file is
  // read at prompt time. A steer or follow-up inside a run, or a definition replaced under a running container,
  // leaves a list naming a file that is gone — and pi answers that by raising `skill_expansion` on the extension
  // error channel and sending the line to the model unexpanded. Nothing else in a turn mentions it, so the agent
  // would simply ignore a skill the caller named.
  const dir = await mkdtemp(join(tmpdir(), "fa-skill-stale-"));
  await mkdir(join(dir, "skills", "weather"), { recursive: true });
  const skillPath = join(dir, "skills", "weather", "SKILL.md");
  await writeFile(skillPath, SKILL("Call the METAR endpoint."));

  const { faux } = makeFaux();
  const seen: string[] = [];
  faux.setResponses([
    (context: { messages: { role: string }[] }) => {
      seen.push(JSON.stringify(context.messages.filter((message) => message.role === "user")));
      return fauxAssistantMessage("ok");
    },
  ]);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const agent = createPiAgentFromSession({
    lease: inProcessLease(),
    sessionFactory: piAgentSessionFactory({
      sessions: piInMemorySessionRecordStore({ cwd: dir }),
      engine: async () => ({ modelRuntime, model: faux.getModel() }),
      // A list that still names the skill, pinned the way a run in flight pins it.
      readDefinition: () => ({
        systemPrompt: "test",
        skills: [{ name: "weather", description: "Report weather.", filePath: skillPath, content: "body" }],
      }),
      cwd: dir,
    }),
  });
  await rm(skillPath);

  const warned: string[] = [];
  const warn = vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));
  try {
    await collect(agent.invoke({ session: "s" }, { text: "/skill:weather now" }));
  } finally {
    warn.mockRestore();
  }

  expect(warned.join("\n")).toMatch(/skill_expansion failed for .*SKILL\.md: ENOENT/);
  expect(seen.join("")).toContain("/skill:weather now"); // unexpanded, as pi leaves it
});

it("a bare `/<name>` expands a PROMPT TEMPLATE — the second spelling the contract now names", async () => {
  // §5.1.1 lists two: `/skill:<name>` for a skill, the bare name for a prompt template. Templates come from the
  // machine (an agent inherits its box), and the expansion is pi's `expandPromptTemplate`, reached for the same
  // reason the skill one is — fastagent never passes `expandPromptTemplates: false`.
  const home = await mkdtemp(join(tmpdir(), "fa-prompt-home-"));
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  // `$ARGUMENTS` is pi's placeholder: a template decides WHERE its arguments land, unlike a skill, where they are
  // appended after the body.
  await writeFile(join(home, ".pi", "agent", "prompts", "triage.md"), "TEMPLATE-BODY-MARKER for: $ARGUMENTS");
  vi.stubEnv("HOME", home);

  const { agent, sent } = await agentWithSkill();
  await collect(agent.invoke({ session: "s" }, { text: "/triage this inbox" }));

  expect(sent()).toContain("TEMPLATE-BODY-MARKER for:");
  expect(sent()).toContain("this inbox");
});

it("an ANONYMOUS caller fires a machine prompt template too — who invokes one changes when you serve", async () => {
  // Documented, not prevented (docs/configuration.md): the data plane's text comes from whoever is talking, so a
  // group member or an unauthenticated POST can put the operator's macro into a turn. It grants no capability the
  // agent lacked — the tools are the same either way — but the decision to run it moves from the author to them,
  // and a name that collides with a platform command (`prompts/start.md` vs Telegram's `/start`) rewrites it.
  const home = await mkdtemp(join(tmpdir(), "fa-prompt-wire-"));
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "prompts", "start.md"), "OPERATOR-MACRO-MARKER $ARGUMENTS");
  vi.stubEnv("HOME", home);

  const { agent, sent } = await agentWithSkill();
  const response = await createInvokeHandler(agent)(
    new Request("http://agent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "s", text: "/start now" }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();

  expect(sent()).toContain("OPERATOR-MACRO-MARKER");
});
