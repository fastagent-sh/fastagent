import { describe, expect, it, vi } from "vitest";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { makeFaux, sentPrompt, sentTools } from "./faux.ts";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  collect,
  createPiAgent,
  createPiAgentFromDefinition,
  defineTool,
  type CreatePiAgentFromDefinitionOptions,
  type AgentEvent,
  z,
} from "../src/index.ts";
import { CODING_TOOL_NAMES, assemblePiFromDefinition, piAllCodingTools } from "../src/harnesses/pi/create.ts";
import { loadAgentDefinition } from "../src/harnesses/pi/definition.ts";
import { log } from "../src/log.ts";
import { isUnderDir } from "../src/paths.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent");

describe("definition: isUnderDir (the leak-guard predicate — does the state root land in the tree?)", () => {
  const dir = "/work";
  it("is true for the dir itself and any path inside it (default `fastagent` OR a custom in-tree root)", () => {
    expect(isUnderDir(dir, dir)).toBe(true); // same dir
    expect(isUnderDir(join(dir, "fastagent"), dir)).toBe(true); // default root
    expect(isUnderDir(join(dir, "data"), dir)).toBe(true); // custom in-tree FASTAGENT_STATE_DIR
    expect(isUnderDir(join(dir, "fastagent", "sessions"), dir)).toBe(true); // nested
  });
  it("is false for external paths (a mounted volume) and sibling dirs sharing a prefix", () => {
    expect(isUnderDir("/mnt/vol", dir)).toBe(false); // operator's volume
    expect(isUnderDir("/work-old", dir)).toBe(false); // prefix sibling, not inside
  });
});

describe("definition: loadAgentDefinition", () => {
  it("loads the appended prompt from APPEND_SYSTEM.md and skills from SKILL.md frontmatter", async () => {
    const def = await loadAgentDefinition(fixtureDir);
    expect(def.appendSystemPrompt?.content).toContain("Haiku Bot");
    expect(def.appendSystemPrompt?.content).toContain("5-7-5");
    expect(def.dir).toBe(fixtureDir);
    expect(def.skills).toHaveLength(1);
    expect(def.skills[0]!.name).toBe("season-words");
    expect(def.skills[0]!.description).toContain("kigo");
    expect(def.diagnostics).toHaveLength(0);
  });

  it("an empty directory is an empty definition, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-empty-definition-"));
    const def = await loadAgentDefinition(dir);
    expect(def.systemPrompt).toBeUndefined();
    expect(def.skills).toEqual([]);
    expect(def.prompts).toEqual([]);
  });

  it("reads SYSTEM.md and APPEND_SYSTEM.md, root spelling over .pi/, and reports the shadowed one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-system-"));
    let def = await loadAgentDefinition(dir);
    expect(def.systemPrompt).toBeUndefined(); // pi builds its default
    expect(def.appendSystemPrompt).toBeUndefined();

    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "SYSTEM.md"), "pi's spelling\n");
    await writeFile(join(dir, ".pi", "APPEND_SYSTEM.md"), "pi's addendum\n");
    def = await loadAgentDefinition(dir);
    expect(def.systemPrompt).toEqual({ path: join(dir, ".pi", "SYSTEM.md"), content: "pi's spelling\n" });
    expect(def.appendSystemPrompt?.content).toBe("pi's addendum\n");
    expect(def.shadowed).toEqual([]);

    await writeFile(join(dir, "SYSTEM.md"), "You are the Repo Bot.\n");
    def = await loadAgentDefinition(dir);
    expect(def.systemPrompt?.path).toBe(join(dir, "SYSTEM.md"));
    expect(def.shadowed).toEqual([
      { what: "system prompt", winnerPath: join(dir, "SYSTEM.md"), loserPath: join(dir, ".pi", "SYSTEM.md") },
    ]);
  });

  it("refuses a persona.md, naming both files that replaced it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-persona-"));
    await writeFile(join(dir, "persona.md"), "You are the Repo Bot.\n");
    await expect(loadAgentDefinition(dir)).rejects.toThrow(
      /persona\.md is no longer read.*SYSTEM\.md.*APPEND_SYSTEM\.md/,
    );
  });

  it("reads skills from skills/, .pi/skills/, .agents/skills/ in that order, reporting a name held twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-skill-dirs-"));
    const skill = async (root: string, name: string, description: string) => {
      await mkdir(join(dir, root, name), { recursive: true });
      await writeFile(
        join(dir, root, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
      );
    };
    await skill("skills", "deploy", "root");
    await skill(".pi/skills", "deploy", "pi");
    await skill(".agents/skills", "review", "standard");
    const def = await loadAgentDefinition(dir);
    expect(def.skills.map((s) => [s.name, s.description])).toEqual([
      ["deploy", "root"],
      ["review", "standard"],
    ]);
    expect(def.collisions).toEqual([
      {
        name: "deploy",
        winnerPath: join(dir, "skills", "deploy", "SKILL.md"),
        loserPath: join(dir, ".pi", "skills", "deploy", "SKILL.md"),
      },
    ]);
  });

  it("refuses a skill whose name holds a slash: the slash names a content entry's skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-skill-slash-"));
    await mkdir(join(dir, "skills", "deploy"), { recursive: true });
    await writeFile(join(dir, "skills", "deploy", "SKILL.md"), "---\nname: app/deploy\ndescription: d\n---\nbody\n");
    await expect(loadAgentDefinition(dir)).rejects.toThrow(/skill "app\/deploy".*may not contain "\/"/);
  });

  it("reads prompt templates from prompts/ then .pi/prompts/, and reports .pi/extensions/ as not loaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-prompts-"));
    await mkdir(join(dir, "prompts"), { recursive: true });
    await mkdir(join(dir, ".pi", "prompts"), { recursive: true });
    await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
    await writeFile(join(dir, "prompts", "review.md"), "---\ndescription: root review\n---\nReview $1\n");
    await writeFile(join(dir, ".pi", "prompts", "review.md"), "pi review\n");
    await writeFile(join(dir, ".pi", "prompts", "ship.md"), "Ship it\n");
    const def = await loadAgentDefinition(dir);
    expect(def.prompts.map((p) => [p.name, p.filePath])).toEqual([
      ["review", join(dir, "prompts", "review.md")],
      ["ship", join(dir, ".pi", "prompts", "ship.md")],
    ]);
    expect(def.prompts[0]?.description).toBe("root review");
    expect(def.shadowed).toEqual([
      {
        what: 'prompt template "review"',
        winnerPath: join(dir, "prompts", "review.md"),
        loserPath: join(dir, ".pi", "prompts", "review.md"),
      },
    ]);
    expect(def.ignored).toEqual([
      { path: join(dir, ".pi", "extensions"), reason: "not loaded: a definition's extensions live in extensions/" },
    ]);
  });

  it("skips a skill whose SKILL.md has no description and surfaces it as a diagnostic (not a crash)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-bad-skill-"));
    await mkdir(join(dir, "skills", "bad"), { recursive: true });
    await writeFile(join(dir, "skills", "bad", "SKILL.md"), "---\nname: bad\n---\nno description.\n");
    const def = await loadAgentDefinition(dir);
    expect(def.skills).toEqual([]); // the malformed skill is skipped, not loaded
    expect(JSON.stringify(def.diagnostics)).toMatch(/description/); // and surfaced, not silently dropped
  });

  // Root reads a file whatever its mode bits say, so the denial below cannot happen there.
  it.skipIf(process.getuid?.() === 0)(
    "SYSTEM.md read errors other than not_found throw instead of silently falling back to pi's default",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "fa-denied-system-"));
      await writeFile(join(dir, "SYSTEM.md"), "You are a bot.\n");
      await chmod(join(dir, "SYSTEM.md"), 0o000);
      try {
        await expect(loadAgentDefinition(dir)).rejects.toThrow(/cannot read .*SYSTEM\.md.*permission denied/);
      } finally {
        await chmod(join(dir, "SYSTEM.md"), 0o644);
      }
    },
  );

  it("loads only the definition's own skills/ — no external or global mount (your directory is the agent)", async () => {
    const def = await loadAgentDefinition(fixtureDir);
    expect(def.skills.map((s) => s.name)).toEqual(["season-words"]);
    expect(def.collisions).toEqual([]);
  });

  it("vendors an Agent Skills standard skill verbatim (cp into skills/): unsupported optional field + progressive disclosure", async () => {
    // Locks the agentskills.io compatibility claim: any standard skill dropped into skills/ Just Works.
    // This is an anthropics/skills-shaped SKILL.md — required name+description plus an OPTIONAL field pi
    // does not model (`license`). Vendoring (a plain cp) must: parse name/description + the full body,
    // IGNORE the unknown optional field WITHOUT a diagnostic, and disclose progressively (name+description
    // in the startup prompt; the body only on activation).
    const dir = await mkdtemp(join(tmpdir(), "fa-vendor-skill-"));
    await writeFile(join(dir, "AGENTS.md"), "# PDF Assistant\n");
    await mkdir(join(dir, "skills", "pdf"), { recursive: true });
    await writeFile(
      join(dir, "skills", "pdf", "SKILL.md"),
      '---\nname: pdf\ndescription: Use this skill whenever the user works with PDF files — extract text, merge, split, or fill forms.\nlicense: Proprietary. LICENSE.txt has complete terms\n---\n\n# PDF Processing Guide\n\nRead a PDF with pypdf: `PdfReader("document.pdf")`.\n',
    );

    const def = await loadAgentDefinition(dir);
    // The unsupported optional `license` field is ignored WITHOUT a diagnostic (graceful degradation).
    expect(def.diagnostics).toEqual([]);
    const pdf = def.skills.find((s) => s.name === "pdf");
    expect(pdf?.description).toContain("PDF files");
    expect(pdf?.filePath).toBe(join(dir, "skills", "pdf", "SKILL.md")); // the body is read from here on activation

    // Progressive disclosure: name + description in the startup prompt; the body is deferred.
    let prompt = "";
    const { faux } = makeFaux();
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1" });
    await collect(agent.invoke({ session: "skill" }, { text: "hi" }));
    expect(prompt).toContain("<name>pdf</name>");
    expect(prompt).toContain("PDF files"); // description disclosed at stage 1
    expect(prompt).not.toContain("pypdf"); // body NOT disclosed until the skill activates
  });
});

describe("create: the prompt pi builds from the definition", () => {
  async function promptOf(dir: string, options: Partial<CreatePiAgentFromDefinitionOptions> = {}): Promise<string> {
    const { faux } = makeFaux();
    let seen = "";
    faux.setResponses([
      (context) => {
        seen = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, {
      providers: [faux.provider],
      model: "faux/faux-1",
      ...options,
    });
    await collect(agent.invoke({ session: "p" }, { text: "hi" }));
    return seen;
  }
  const lookup = defineTool({
    name: "lookup",
    description: "Look up an order by id.\nLonger notes the list does not need.",
    input: z.object({ id: z.string() }),
    execute: async () => "found",
  });

  it("without SYSTEM.md is pi's own default: its identity, each tool by pi's line, its rules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-default-prompt-"));
    const prompt = await promptOf(dir, { tools: [...piAllCodingTools(dir), lookup] });
    expect(prompt).toContain("You are an expert coding assistant operating inside pi");
    for (const name of CODING_TOOL_NAMES) expect(prompt).toContain(`- ${name}:`);
    // An authored tool is listed by the first line of its description, like pi lists its own.
    expect(prompt).toContain("- lookup: Look up an order by id.");
    expect(prompt).not.toContain("Longer notes");
    expect(prompt).toContain("Use read to examine files instead of cat or sed."); // pi's guideline for its read tool
    expect(prompt).toContain("Pi documentation");
  });

  it("SYSTEM.md replaces pi's default and APPEND_SYSTEM.md follows it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-system-prompt-"));
    await writeFile(join(dir, "SYSTEM.md"), "You are the Repo Bot.");
    await writeFile(join(dir, "APPEND_SYSTEM.md"), "Always cite the file you read.");
    const prompt = await promptOf(dir);
    expect(prompt.startsWith("You are the Repo Bot.")).toBe(true);
    expect(prompt).not.toContain("operating inside pi");
    expect(prompt).toContain("<addendum>\nAlways cite the file you read.\n</addendum>");
  });

  it("never takes the machine's SYSTEM.md or APPEND_SYSTEM.md: a prompt from a machine would make the agent its owner's", async () => {
    const machine = await mkdtemp(join(tmpdir(), "fa-machine-prompt-"));
    await writeFile(join(machine, "SYSTEM.md"), "MACHINE IDENTITY");
    await writeFile(join(machine, "APPEND_SYSTEM.md"), "MACHINE ADDENDUM");
    vi.stubEnv("PI_CODING_AGENT_DIR", machine);
    try {
      const dir = await mkdtemp(join(tmpdir(), "fa-no-machine-prompt-"));
      const prompt = await promptOf(dir);
      expect(prompt).toContain("operating inside pi");
      expect(prompt).not.toContain("MACHINE IDENTITY");
      expect(prompt).not.toContain("MACHINE ADDENDUM");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("FastAgent's own sections hold under a SYSTEM.md that replaced pi's default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sections-"));
    await writeFile(join(dir, "SYSTEM.md"), "You are the Repo Bot.");
    const deferred = defineTool({
      name: "rare",
      description: "Rarely needed.",
      input: z.object({}),
      exposure: "deferred",
      execute: async () => "ok",
    });
    const prompt = await promptOf(dir, { tools: [...piAllCodingTools(dir), deferred] });
    expect(prompt).toMatch(/<deferred_tools>\n1 additional tool\(s\) are registered but not loaded/);
  });

  it("an empty SYSTEM.md is no prompt of the agent's own: reported, pi's default used, replaced tools still refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-empty-system-"));
    await writeFile(join(dir, "SYSTEM.md"), "  \n");
    const def = await loadAgentDefinition(dir);
    expect(def.systemPrompt).toBeUndefined();
    expect(def.ignored).toEqual([
      { path: join(dir, "SYSTEM.md"), reason: "empty, so it is not used as the system prompt" },
    ]);
    expect(await promptOf(dir)).toContain("operating inside pi");
    const options = { providers: [makeFaux().faux.provider], model: "faux/faux-1", tools: [lookup] };
    await expect(createPiAgentFromDefinition(dir, options)).rejects.toThrow(/coding tools were replaced/);
    await expect(createPiAgentFromDefinition(dir, { ...options, base: "" })).rejects.toThrow(/`base` is empty/);
  });

  it("refuses pi's default over replaced coding tools, at assembly and on the turn SYSTEM.md disappears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-replaced-tools-"));
    const options = { providers: [makeFaux().faux.provider], model: "faux/faux-1", tools: [lookup] };
    await expect(createPiAgentFromDefinition(dir, options)).rejects.toThrow(
      /coding tools were replaced \(read, bash, edit, write not mounted\).*pass `base` or write SYSTEM\.md/,
    );
    await expect(createPiAgentFromDefinition(dir, { ...options, base: "You look up orders." })).resolves.toBeDefined();

    await writeFile(join(dir, "SYSTEM.md"), "You look up orders.");
    const { faux } = makeFaux();
    faux.setResponses([fauxAssistantMessage("ok")]);
    const { agent } = await createPiAgentFromDefinition(dir, { ...options, providers: [faux.provider] });
    await rm(join(dir, "SYSTEM.md"));
    await expect(collect(agent.invoke({ session: "gone" }, { text: "hi" }))).rejects.toThrow(
      /coding tools were replaced/,
    );
  });
});

describe("create L2: types only promise options the implementation honors", () => {
  it("L2 options do not accept skills/instructions because they come from the definition directory", () => {
    const base: CreatePiAgentFromDefinitionOptions = { model: "p/m" };
    expect(base.model).toBeDefined();
    // @ts-expect-error -- skills must come from the definition directory, not the caller
    const withSkills: CreatePiAgentFromDefinitionOptions = { model: "p/m", skills: [] };
    // @ts-expect-error -- instructions are assembled from the definition (AGENTS.md), not passed in
    const withPrompt: CreatePiAgentFromDefinitionOptions = { model: "p/m", instructions: "x" };
    expect(withSkills).toBeDefined();
    expect(withPrompt).toBeDefined();
  });
});

describe("create: createPiAgentFromDefinition (directory → agent)", () => {
  it("assembled systemPrompt reaches the model; skills are injected as resources; read tool is present by default", async () => {
    let seenSystemPrompt: string | undefined;
    let seenTools: string[] = [];
    const { faux } = makeFaux();
    faux.setResponses([
      (context) => {
        seenSystemPrompt = sentPrompt(context);
        seenTools = sentTools(context);
        return fauxAssistantMessage("old pond… — haiku-bot");
      },
    ]);

    const { agent, definition } = await createPiAgentFromDefinition(fixtureDir, {
      providers: [faux.provider],
      model: "faux/faux-1",
    });
    expect(definition.skills).toHaveLength(1);
    expect(definition.diagnostics).toHaveLength(0);

    const { text } = await collect(agent.invoke({ session: "s" }, { text: "write a haiku" }));
    expect(text).toContain("haiku-bot");
    // definition content actually reached the system prompt; base inherited from pi; tool list includes read
    expect(seenSystemPrompt).toContain("Haiku Bot");
    expect(seenSystemPrompt).toContain("season-words");
    expect(seenSystemPrompt?.match(/<available_skills>/g)).toHaveLength(1);
    expect(seenSystemPrompt?.match(/<cwd>/g)).toHaveLength(1);
    expect(seenSystemPrompt).toContain("operating inside pi");
    expect(seenSystemPrompt).toContain("- read:");
    // Every directory agent gets pi's complete coding set. Custom tools stay an explicit `tools:`
    // injection, with no second discovery mechanism.
    // What the MODEL is handed. pi 0.84.3 keeps a `powershell` in the session registry that never
    // reaches this list — if it ever does, this line is where it shows.
    expect(seenTools.sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });
});

describe("create L1: createPiAgent (instructions ARE the prompt)", () => {
  it("reads dynamic instructions once per invoke, never during construction", async () => {
    const { faux } = makeFaux();
    const seen: string[] = [];
    const instructions = vi.fn((): string => `Instruction ${instructions.mock.calls.length}`);
    faux.setResponses(
      [1, 2].map(() => (context) => {
        seen.push(sentPrompt(context));
        return fauxAssistantMessage("ok");
      }),
    );
    const agent = createPiAgent({ model: "faux/faux-1", providers: [faux.provider], instructions });
    expect(instructions).not.toHaveBeenCalled();

    await collect(agent.invoke({ session: "dynamic" }, { text: "first" }));
    expect(instructions).toHaveBeenCalledTimes(1);
    await collect(agent.invoke({ session: "dynamic" }, { text: "second" }));
    expect(instructions).toHaveBeenCalledTimes(2);
    expect(seen[0]).toContain("Instruction 1");
    expect(seen[1]).toContain("Instruction 2");
  });

  it("reports an instruction read failure as a turn failure and recovers on the next invoke", async () => {
    const { faux } = makeFaux();
    faux.setResponses([fauxAssistantMessage("recovered")]);
    const instructions = vi
      .fn(() => "Ready")
      .mockImplementationOnce(() => {
        throw new Error("instructions unavailable");
      });
    const agent = createPiAgent({ model: "faux/faux-1", providers: [faux.provider], instructions });
    const failed: AgentEvent[] = [];
    for await (const event of agent.invoke({ session: "dynamic-failure" }, { text: "first" })) failed.push(event);
    expect(failed).toMatchObject([{ type: "failed", details: "instructions unavailable" }]);
    expect((await collect(agent.invoke({ session: "dynamic-failure" }, { text: "second" }))).text).toBe("recovered");
    expect(instructions).toHaveBeenCalledTimes(2);
  });

  it("resolves a model spec string and sends instructions verbatim — no harness base prepended", async () => {
    let seen: string | undefined;
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen = sentPrompt(ctx);
        return fauxAssistantMessage("ok");
      },
    ]);
    const agent = createPiAgent({
      providers: [faux.provider],
      model: "faux/faux-1",
      instructions: "You are a support bot.",
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    // pi appends its own working-directory line; what matters is that nothing else was imposed.
    expect((seen ?? "").split("\n\n<cwd>")[0]).toBe("You are a support bot.");
    expect(seen).not.toContain("operating inside pi"); // no harness identity forced on a hand-built agent
  });

  it("cannot activate a coding tool omitted from its replacement set", async () => {
    let activated: string[] | undefined;
    let offeredAfter: string[] = [];
    const { faux } = makeFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("try_enable_bash", {}, { id: "c1" })),
      (context) => {
        offeredAfter = sentTools(context);
        return fauxAssistantMessage("done");
      },
    ]);
    const agent = createPiAgent({
      providers: [faux.provider],
      model: "faux/faux-1",
      tools: [
        defineTool({
          name: "try_enable_bash",
          description: "Try to enable bash.",
          input: z.object({}),
          execute: async (_input, ctx) => {
            activated = await ctx.tools?.activate(["bash"]);
            return activated;
          },
        }),
      ],
    });

    await collect(agent.invoke({ session: "s" }, { text: "enable bash" }));
    expect(activated).toEqual([]);
    expect(offeredAfter).toEqual(["try_enable_bash"]);
  });

  it("lists skills only with an active read tool — a skill nothing can open is not offered", async () => {
    for (const read of [true, false]) {
      let seen: string | undefined;
      const { faux } = makeFaux();
      faux.setResponses([
        (ctx) => {
          seen = sentPrompt(ctx);
          return fauxAssistantMessage("ok");
        },
      ]);
      const { skills } = await loadAgentDefinition(fixtureDir);
      const agent = createPiAgent({
        providers: [faux.provider],
        model: "faux/faux-1",
        instructions: () => "P",
        skills,
        tools: read ? createReadOnlyTools(fixtureDir) : [],
      });
      await collect(agent.invoke({ session: "s" }, { text: "hi" }));
      expect(seen, `read: ${read}`).toContain("P");
      expect(seen?.match(/<available_skills>/g) ?? [], `read: ${read}`).toHaveLength(read ? 1 : 0);
      expect(seen?.match(/<cwd>/g)).toHaveLength(1);
    }
  });

  it("empty instructions impose no coding identity, in every form they arrive in", async () => {
    for (const instructions of [undefined, "", () => ""]) {
      let seen: string | undefined;
      const { faux } = makeFaux();
      faux.setResponses([
        (ctx) => {
          seen = sentPrompt(ctx);
          return fauxAssistantMessage("ok");
        },
      ]);
      const agent = createPiAgent({ providers: [faux.provider], model: "faux/faux-1", instructions });
      await collect(agent.invoke({ session: "s" }, { text: "hi" }));
      // The invariant fastagent owns: a hand-built agent is never forced into pi's coding persona.
      // (pi fills its own neutral default; that exact string is pi's behavior, not our contract.)
      const label = String(instructions);
      expect(seen, label).toBeDefined(); // a system prompt did reach the model — guards against a vacuous pass
      expect(seen, label).not.toContain("operating inside pi"); // no harness identity forced on a hand-built agent
    }
  });
});

describe("create: toolset (real pi tools, fidelity)", () => {
  it("piAllCodingTools is every pi coding tool", () => {
    // Asserted against pi's own groupings rather than a hand-written list, so the set follows
    // upstream; the ORDER is ours, and it is what directory agents report and mount.
    const names = piAllCodingTools(process.cwd()).map((t) => t.name);
    expect(names).toEqual([...CODING_TOOL_NAMES]);
    expect([...names].sort()).toEqual(
      [
        ...new Set([...createReadOnlyTools(process.cwd()), ...createCodingTools(process.cwd())].map((t) => t.name)),
      ].sort(),
    );
  });

  it("pi's read tool is rooted at the directory it was built for", async () => {
    // The root is fixed at CONSTRUCTION, not handed in per turn: these are pi-coding-agent's tools, which take a cwd.
    // Every caller builds them for the agent directory, so a relative path resolves against it and nothing else.
    const read = piAllCodingTools(fixtureDir).find((t) => t.name === "read")!;
    const r = await read.execute("t1", { path: "APPEND_SYSTEM.md" });
    const text = (r.content[0] as any).text as string;
    expect(text).toContain("Haiku Bot");
  });
});

describe("create L2: the directory is LIVE (definition re-read per invoke)", () => {
  it("an APPEND_SYSTEM.md/skill edit between two invokes reaches the next turn's prompt and skill resources — no restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-"));
    await writeFile(join(dir, "APPEND_SYSTEM.md"), "Sign as DRAFT-PERSONA.\n");
    const seen: (string | undefined)[] = [];
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen.push(sentPrompt(ctx));
        return fauxAssistantMessage("one");
      },
      (ctx) => {
        seen.push(sentPrompt(ctx));
        return fauxAssistantMessage("two");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1" });

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    // The edit an agent might make to itself mid-conversation: new standing instructions + a new skill.
    await writeFile(join(dir, "APPEND_SYSTEM.md"), "Sign as FINAL-PERSONA.\n");
    await mkdir(join(dir, "skills", "late-skill"), { recursive: true });
    await writeFile(
      join(dir, "skills", "late-skill", "SKILL.md"),
      "---\nname: late-skill\ndescription: added after boot\n---\nBody.\n",
    );
    await collect(agent.invoke({ session: "s" }, { text: "again" }));

    expect(seen[0]).toContain("DRAFT-PERSONA");
    expect(seen[0]).not.toContain("late-skill");
    expect(seen[1]).toContain("FINAL-PERSONA");
    expect(seen[1]).not.toContain("DRAFT-PERSONA");
    expect(seen[1]).toContain("late-skill"); // the listing comes from the SAME re-read as the prompt
  });

  it("a SYSTEM.md edit between two invokes reaches the next turn's prompt — no restart", async () => {
    // The prompt must come from the per-turn definition read rather than a boot-time snapshot.
    const dir = await mkdtemp(join(tmpdir(), "fa-live-system-"));
    await writeFile(join(dir, "SYSTEM.md"), "You are DRAFT-BOT.\n");
    const seen: (string | undefined)[] = [];
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen.push(sentPrompt(ctx));
        return fauxAssistantMessage("one");
      },
      (ctx) => {
        seen.push(sentPrompt(ctx));
        return fauxAssistantMessage("two");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1" });

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    await writeFile(join(dir, "SYSTEM.md"), "You are FINAL-BOT.\n");
    await collect(agent.invoke({ session: "s" }, { text: "again" }));

    expect(seen[0]).toContain("DRAFT-BOT");
    expect(seen[0]).not.toContain("operating inside pi"); // SYSTEM.md replaces pi's default prompt
    expect(seen[1]).toContain("FINAL-BOT");
    expect(seen[1]).not.toContain("DRAFT-BOT"); // live re-read, not the boot-time closure value
  });

  it("a bad skill written at runtime is surfaced as a warning on the affected turn, never silently dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-bad-"));
    await writeFile(join(dir, "AGENTS.md"), "You are a bot.\n");
    const { faux } = makeFaux();
    faux.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")]);
    const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1" });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    // The agent (or author) writes a skill with broken frontmatter mid-conversation. The loader
    // returns this as a diagnostic (data, not a throw) — the live path must re-report it.
    await mkdir(join(dir, "skills", "broken"), { recursive: true });
    await writeFile(join(dir, "skills", "broken", "SKILL.md"), "no frontmatter at all\n");
    const warn = vi.spyOn(log, "warn");
    try {
      const { text } = await collect(agent.invoke({ session: "s" }, { text: "again" }));
      expect(text).toBe("two"); // non-fatal: the turn still completes
      const brokenWarns = () => warn.mock.calls.filter((c) => String(c[0]).includes("broken")).length;
      expect(brokenWarns()).toBeGreaterThan(0);

      // …but an UNCHANGED finding set does not re-warn on the next turn (no per-turn log spam).
      faux.appendResponses([() => fauxAssistantMessage("three")]);
      await collect(agent.invoke({ session: "s" }, { text: "once more" }));
      expect(brokenWarns()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  // Root reads a file whatever its mode bits say, so the denial below cannot happen there.
  it.skipIf(process.getuid?.() === 0)(
    "a throw-class broken edit fails THAT turn as a failed event — the agent survives and the next good turn recovers",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "fa-live-throw-"));
      await writeFile(join(dir, "AGENTS.md"), "You are a bot.\n");
      const system = join(dir, "SYSTEM.md");
      await writeFile(system, "You are a bot.\n");
      const { faux } = makeFaux();
      faux.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("recovered")]);
      const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1" });
      await collect(agent.invoke({ session: "s" }, { text: "hi" }));

      await chmod(system, 0o000); // the live re-read now throws (unreadable SYSTEM.md)
      const events: string[] = [];
      let details = "";
      for await (const e of agent.invoke({ session: "s" }, { text: "again" })) {
        events.push(e.type);
        if (e.type === "failed") details = e.details;
      }
      expect(events).toEqual(["failed"]); // SPEC MUST 2: a failed event, not a thrown iteration error
      expect(details).toMatch(/SYSTEM\.md/);

      await chmod(system, 0o644); // the next good edit heals it — same agent, no restart
      const { text } = await collect(agent.invoke({ session: "s" }, { text: "back" }));
      expect(text).toBe("recovered");
    },
  );
});

describe("definition: skills/ gets the same containment guard as tools/channels/schedules", () => {
  it("refuses a skills/ symlink that escapes the agent dir instead of loading through it", async () => {
    // The three sibling surfaces already refuse this at DISCOVERY, and vendor-skill refuses it when
    // WRITING; loading through it was the one way out of the definition directory.
    const { symlink } = await import("node:fs/promises");
    const outside = await mkdtemp(join(tmpdir(), "fa-outside-"));
    await mkdir(join(outside, "sneaky"), { recursive: true });
    await writeFile(join(outside, "sneaky", "SKILL.md"), "---\nname: sneaky\ndescription: d\n---\nx\n");
    const agent = join(await mkdtemp(join(tmpdir(), "fa-skills-escape-")), "fastagent");
    await mkdir(agent);
    await symlink(outside, join(agent, "skills"));
    await expect(loadAgentDefinition(agent)).rejects.toThrow(/resolves outside the agent dir/);
  });
});

describe("create L2: an explicit tools list states its own coding capabilities", () => {
  it("does not claim a caller passing `read` lacks a file reader", async () => {
    // `tools` is the caller stating the whole surface, which used to be read as "no coding tools at
    // all" — so an L2 caller who passed a reader got the capability-neutral identity AND a warning
    // that their model-visible skills had no way to read themselves.
    const dir = await mkdtemp(join(tmpdir(), "fa-l2-caps-"));
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await mkdir(join(dir, "skills", "triage"), { recursive: true });
    await writeFile(
      join(dir, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Triage things.\n---\n\nSteps.\n",
    );
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { faux } = makeFaux();
    faux.setResponses([fauxAssistantMessage("ok")]);
    try {
      await createPiAgentFromDefinition(dir, {
        model: "faux/faux-1",
        providers: [faux.provider],
        tools: piAllCodingTools(process.cwd()),
      });
      expect(warn.mock.calls.flat().join("\n")).not.toMatch(/reader/i);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("create L2: the agent directory is the working directory", () => {
  it("roots the tools there, tells the model so, and loads its own AGENTS.md but never a parent's", async () => {
    // The agent directory's AGENTS.md is read like any working directory's; one above it belongs to no declared
    // context and is not read. Driven through the real agent: a tool rooted elsewhere, or a prompt naming
    // another directory, is invisible to anything but a turn.
    const parent = await mkdtemp(join(tmpdir(), "fa-parent-"));
    const definitionDir = join(parent, "agent");
    await mkdir(definitionDir);
    await writeFile(join(parent, "AGENTS.md"), "The marker is FROM-PARENT.\n");
    await writeFile(join(definitionDir, "AGENTS.md"), "The marker is FROM-OWN-AGENTS.\n");
    await writeFile(join(definitionDir, "marker.txt"), "READ-FROM-DEFINITION-DIR\n");

    const { faux } = makeFaux();
    let systemPrompt = "";
    // First turn: call `read` on a bare relative path, which resolves against the root the tool was built for.
    faux.setResponses([
      (context) => {
        systemPrompt = sentPrompt(context);
        return {
          ...fauxAssistantMessage(""),
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "marker.txt" } }],
        } as ReturnType<typeof fauxAssistantMessage>;
      },
      fauxAssistantMessage("done"),
    ]);
    const { agent } = await createPiAgentFromDefinition(definitionDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
    });
    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "hi" })) events.push(e);
    expect(JSON.stringify(events)).toContain("READ-FROM-DEFINITION-DIR");
    expect(systemPrompt).toContain(`<cwd>\n${definitionDir}\n</cwd>`);
    expect(systemPrompt).toContain("FROM-OWN-AGENTS");
    expect(systemPrompt).not.toContain("FROM-PARENT");
  });
});

describe("create L2: explicit tools replace the coding defaults", () => {
  it("keeps omitted built-ins inactive — the model is never offered one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-l2-tools-"));
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    const { faux } = makeFaux();
    const { assembly } = await assemblePiFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: piAllCodingTools(dir).filter((tool) => tool.name === "read"),
    });

    const session = await assembly.sessionFactory("s");
    // ACTIVE is the property that matters: what the model is offered and may call. The registry may
    // hold more than we passed — pi 0.84.3 keeps its own `powershell` there — but nothing we omitted
    // is ever ACTIVATED, and that is the guarantee. What the model actually receives is asserted in
    // the systemPrompt test above.
    expect(session.getActiveToolNames()).toEqual(["read"]);
    // Reactivation is the attack: a later native loader uses this same call and must not
    // be able to hand back something the caller left out. `powershell` is in the list because pi
    // registers it whatever we pass (0.84.3), which is precisely why it has to be excluded too.
    session.setActiveToolsByName(["read", "bash", "write", "powershell"]);
    expect(session.getActiveToolNames()).toEqual(["read"]);
  });

  it("does not claim a coding surface it did not mount: the caller's `base` is the prompt", async () => {
    // pi's default says the agent executes commands and edits files, which is false with only read and grep mounted.
    // The model has no way to find that out except by trying, so the caller states the prompt (`base`), and without
    // one the assembly is refused (the prompt test above).
    const dir = await mkdtemp(join(tmpdir(), "fa-identity-"));
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: piAllCodingTools(dir).filter((t) => t.name === "read" || t.name === "grep"),
      base: "You read and search files.",
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(prompt.startsWith("You read and search files.")).toBe(true);
    expect(prompt).not.toContain("executing commands");
  });
});

describe("skills/: a plain note is not a broken skill", () => {
  it("ignores a root .md without skill frontmatter, and still loads the real one", async () => {
    // Our own scaffold ships one (writing-great-skills/GLOSSARY.md). Before pi 0.84.3 every such file
    // produced an `invalid_metadata` diagnostic on every start — a warning the author could not act on.
    const dir = await mkdtemp(join(tmpdir(), "fa-skills-note-"));
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await mkdir(join(dir, "skills", "demo"), { recursive: true });
    await writeFile(
      join(dir, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill.\n---\nBody.\n",
    );
    await writeFile(join(dir, "skills", "NOTES.md"), "Just notes, no frontmatter.\n");

    const definition = await loadAgentDefinition(dir);
    expect(definition.skills.map((s) => s.name)).toEqual(["demo"]);
    expect(definition.diagnostics).toEqual([]);
  });
});
