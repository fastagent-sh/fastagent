/**
 * An agent inherits the machine it runs on (docs/design/core.md §5).
 *
 * The rule it replaced was "skills come ONLY from the definition's own `skills/`", whose reason was portability: a
 * definition that loads different skills on different machines behaves differently once deployed. The reason it
 * lost to is that the agent ALREADY inherits the box — `bash` runs whatever is on the PATH, `read` opens whatever
 * is on the disk — so treating the machine's executables as environment and its skills as contamination was a line
 * drawn in the wrong place. What replaces the guarantee is a report at the moment the artifact leaves the machine
 * (`deploy`'s pre-flight), which is when an author can act on it.
 *
 * These tests stub HOME on purpose: `test/setup.ts` gives every file an EMPTY one, so anything here is the
 * machine's contribution and nothing else.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { collect, createPiAgentFromDefinition } from "../src/index.ts";
import { resolveCommandSurface } from "../src/engines/pi/agent-session-factory.ts";
import { makeFaux, sentPrompt } from "./faux.ts";

afterEach(() => vi.unstubAllEnvs());

/** A machine with skills and prompt templates of its own, as pi keeps them. */
async function machine(files: { skills?: Record<string, string>; prompts?: Record<string, string> }): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fa-machine-"));
  const agent = join(home, ".pi", "agent");
  for (const [name, description] of Object.entries(files.skills ?? {})) {
    await mkdir(join(agent, "skills", name), { recursive: true });
    await writeFile(
      join(agent, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`,
    );
  }
  for (const [name, body] of Object.entries(files.prompts ?? {})) {
    await mkdir(join(agent, "prompts"), { recursive: true });
    await writeFile(join(agent, "prompts", `${name}.md`), body);
  }
  vi.stubEnv("HOME", home);
  return home;
}

/** An agent directory with its own skills. */
async function definition(skills: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-def-"));
  await writeFile(join(dir, "persona.md"), "You are terse.\n");
  for (const [name, description] of Object.entries(skills)) {
    await mkdir(join(dir, "skills", name), { recursive: true });
    await writeFile(
      join(dir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nDefinition's ${name}.\n`,
    );
  }
  return dir;
}

/** Run one turn and return the system prompt the model was sent. */
async function promptSentBy(dir: string): Promise<string> {
  const { faux } = makeFaux();
  let sent = "";
  faux.setResponses([
    (context) => {
      sent = sentPrompt(context);
      return fauxAssistantMessage("ok");
    },
  ]);
  const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
  await collect(agent.invoke({ session: "s" }, { text: "hi" }));
  return sent;
}

it("a skill installed on the machine reaches the model", async () => {
  await machine({ skills: { metar: "Read aviation weather." } });
  expect(await promptSentBy(await definition())).toContain("Read aviation weather.");
});

it("the DEFINITION wins a name collision — vendoring one in is how an author overrides the machine", async () => {
  await machine({ skills: { metar: "The MACHINE version." } });
  const prompt = await promptSentBy(await definition({ metar: "The DEFINITION version." }));

  expect(prompt).toContain("The DEFINITION version.");
  expect(prompt).not.toContain("The MACHINE version.");
});

it("`commands()` says which names TRAVEL and which belong to this box", async () => {
  // The client's only way to warn before someone builds a workflow on a name that will not be in the image.
  await machine({ skills: { metar: "Machine skill." }, prompts: { review: "Review this: " } });
  const dir = await definition({ digest: "Definition skill." });

  const commands = await resolveCommandSurface(dir, dir);

  expect(commands).toEqual(
    expect.arrayContaining([
      { name: "digest", description: "Definition skill.", source: "skill" },
      { name: "metar", description: "Machine skill.", source: "machine-skill" },
      expect.objectContaining({ name: "review", source: "machine-prompt" }),
    ]),
  );
});

it("an empty machine contributes nothing — the definition is still the whole answer", async () => {
  // `test/setup.ts`'s empty HOME is this case, and it is the one a container is in.
  const dir = await definition({ digest: "Definition skill." });
  expect(await resolveCommandSurface(dir, dir)).toEqual([
    { name: "digest", description: "Definition skill.", source: "skill" },
  ]);
});
