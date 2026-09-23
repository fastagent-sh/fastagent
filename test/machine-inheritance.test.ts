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
import { log } from "../src/log.ts";
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

it("a PROJECT-level skill travels, and is not reported as the machine's", async () => {
  // pi discovers `.pi/skills` and `.agents/skills` under the workspace as well as the user-level ones, and those
  // ride into the image with `COPY . .`. Calling them "from this machine" is the opposite of what happens, in the
  // one message meant to warn an author.
  await machine({ skills: { fromhome: "User-level." } });
  const dir = await definition();
  for (const [where, name] of [
    [".pi/skills", "piloc"],
    [".agents/skills", "agloc"],
  ] as const) {
    await mkdir(join(dir, where, name), { recursive: true });
    await writeFile(join(dir, where, name, "SKILL.md"), `---\nname: ${name}\ndescription: In the repo.\n---\nbody\n`);
  }

  const bySource = new Map((await resolveCommandSurface(dir, dir)).map((c) => [c.name, c.source]));

  expect(bySource.get("piloc")).toBe("skill");
  expect(bySource.get("agloc")).toBe("skill");
  expect(bySource.get("fromhome")).toBe("machine-skill"); // the one that really is only here
});

it("a broken SKILL.md on the machine says so — it is the silence this change was about", async () => {
  // Absent from the prompt, absent from the list, and until now absent from the logs too: an author with a
  // description-less skill in `~/.pi/agent/skills` had nothing at all to read.
  const home = await mkdtemp(join(tmpdir(), "fa-machine-broken-"));
  await mkdir(join(home, ".pi", "agent", "skills", "broken"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "skills", "broken", "SKILL.md"),
    "---\nname: broken\n---\nno description\n",
  );
  vi.stubEnv("HOME", home);
  const warned: string[] = [];
  const warn = vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));

  const commands = await resolveCommandSurface(await definition(), await definition());
  warn.mockRestore();

  expect(commands.map((c) => c.name)).not.toContain("broken");
  // The whole line, because the name is in the path either way: a `${d.code}` that pi's `ResourceDiagnostic` does
  // not have rendered this as `[fastagent] undefined: …`, and a test matching the name could not see it.
  expect(warned.join("\n")).toMatch(/^\[fastagent\] skill warning: .*description.*SKILL\.md\)$/m);
});

it("the machine's half is read ONCE — a definition that did not change does not reload the loader", async () => {
  // The merge made `definitionChanged` true whenever the machine had any skill at all, because the loader's list
  // (definition + machine) was being compared against the definition's half. Every turn then paid a full
  // `reload()` on a loader concurrent turns share. The cost is invisible; the tell is that the machine's half
  // became live, which it is not: like a `PATH` entry added after a process started, it lands on the next boot.
  const home = await machine({ skills: { drift: "First description." } });
  const dir = await definition();
  const { faux } = makeFaux();
  const sent: string[] = [];
  faux.setResponses(
    Array.from({ length: 2 }, () => (context: Parameters<typeof sentPrompt>[0]) => {
      sent.push(sentPrompt(context));
      return fauxAssistantMessage("ok");
    }),
  );
  const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
  await collect(agent.invoke({ session: "s" }, { text: "one" }));

  await writeFile(
    join(home, ".pi", "agent", "skills", "drift", "SKILL.md"),
    "---\nname: drift\ndescription: Second description.\n---\nbody\n",
  );
  await collect(agent.invoke({ session: "s" }, { text: "two" }));

  expect(sent[1]).toContain("First description.");
  expect(sent[1]).not.toContain("Second description.");
});

it("lists and runs the SAME machine — a skill installed after boot is in neither", async () => {
  // The menu used to re-discover per call while a bound session read once, so `/` could offer a name the very
  // next prompt would pass through as prose. Both halves come from one read now.
  const home = await machine({ skills: { early: "Present at boot." } });
  const dir = await definition();
  expect((await resolveCommandSurface(dir, dir)).map((c) => c.name)).toEqual(["early"]);

  await mkdir(join(home, ".pi", "agent", "skills", "late"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "skills", "late", "SKILL.md"),
    "---\nname: late\ndescription: Installed after boot.\n---\nbody\n",
  );

  expect(
    (await resolveCommandSurface(dir, dir)).map((c) => c.name),
    "offered a name no turn would expand",
  ).toEqual(["early"]);
  expect(await promptSentBy(dir)).not.toContain("Installed after boot.");
});

it("reports the machine's broken files ONCE, not once per `GET /control/commands`", async () => {
  const home = await mkdtemp(join(tmpdir(), "fa-machine-once-"));
  await mkdir(join(home, ".pi", "agent", "skills", "broken"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "skills", "broken", "SKILL.md"),
    "---\nname: broken\n---\nno description\n",
  );
  vi.stubEnv("HOME", home);
  const dir = await definition();
  const warned: string[] = [];
  const warn = vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));

  for (let i = 0; i < 3; i++) await resolveCommandSurface(dir, dir);
  warn.mockRestore();

  // `commands()` is an unauthenticated route (`GET /control/commands`): a caller decides how often this runs.
  expect(
    warned.filter((line) => line.includes("description")),
    warned.join("\n"),
  ).toHaveLength(1);
});
