import { describe, expect, it, vi } from "vitest";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { makeFaux } from "./faux.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FileError, err } from "@earendil-works/pi-agent-core";
import {
  collect,
  createPiAgent,
  createPiAgentFromDefinition,
  defineTool,
  type CreatePiAgentFromDefinitionOptions,
  z,
} from "../src/index.ts";
import {
  CODING_TOOL_NAMES,
  assembleSystemPrompt,
  type PiAssemblyParts,
  piAllCodingTools,
  piBasePrompt,
} from "../src/engines/pi/create.ts";
import { loadAgentDefinition } from "../src/engines/pi/definition.ts";
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
  it("loads instructions from AGENTS.md and skills from SKILL.md frontmatter", async () => {
    const def = await loadAgentDefinition(fixtureDir);
    expect(def.contextFiles.map((f) => f.content).join("\n")).toContain("Haiku Bot");
    expect(def.contextFiles.map((f) => f.content).join("\n")).toContain("5-7-5");
    expect(def.dir).toBe(fixtureDir); // AGENTS.md path is derivable: join(dir, "AGENTS.md")
    expect(def.skills).toHaveLength(1);
    expect(def.skills[0]!.name).toBe("season-words");
    expect(def.skills[0]!.description).toContain("kigo");
    expect(def.diagnostics).toHaveLength(0);
  });

  it("missing AGENTS.md / skills returns undefined instructions and empty skills without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-empty-definition-"));
    const def = await loadAgentDefinition(dir);
    expect(def.contextFiles).toEqual([]);
    expect(def.skills).toEqual([]);
  });

  it("loads persona.md into persona (segment ①); absent → undefined; AGENTS.md stays the ② field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-persona-"));
    await writeFile(join(dir, "AGENTS.md"), "# Repo spec\nProject rules here.\n");
    let def = await loadAgentDefinition(dir);
    expect(def.persona).toBeUndefined(); // no persona.md → segment ① falls back to engine identity
    expect(def.contextFiles.map((f) => f.content).join("\n")).toContain("Repo spec"); // AGENTS.md → ② context, not persona

    await writeFile(join(dir, "persona.md"), "You are the Repo Bot. Reply briefly.\n");
    def = await loadAgentDefinition(dir);
    expect(def.persona).toContain("Repo Bot"); // persona.md → persona (①)
    expect(def.contextFiles.map((f) => f.content).join("\n")).toContain("Repo spec"); // AGENTS.md unchanged, still ②
  });

  it("skips a skill whose SKILL.md has no description and surfaces it as a diagnostic (not a crash)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-bad-skill-"));
    await mkdir(join(dir, "skills", "bad"), { recursive: true });
    await writeFile(join(dir, "skills", "bad", "SKILL.md"), "---\nname: bad\n---\nno description.\n");
    const def = await loadAgentDefinition(dir);
    expect(def.skills).toEqual([]); // the malformed skill is skipped, not loaded
    expect(JSON.stringify(def.diagnostics)).toMatch(/description/); // and surfaced, not silently dropped
  });

  it("agentDir ≠ cwd: persona from agentDir, ② context walked from cwd (the host repo's AGENTS.md) + agentDir's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-repo-"));
    await writeFile(join(root, "AGENTS.md"), "# Host repo spec\n"); // the repo's context, at cwd
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "persona.md"), "You are the Repo Bot.\n"); // ① identity, in agentDir
    await writeFile(join(agentDir, "AGENTS.md"), "# Agent own note\n"); // agentDir's own ② too

    const def = await loadAgentDefinition(agentDir, { cwd: root });
    expect(def.persona).toContain("Repo Bot"); // ① from agentDir
    expect(def.dir).toBe(agentDir);
    const paths = def.contextFiles.map((f) => f.path);
    expect(paths).toContain(join(agentDir, "AGENTS.md")); // agentDir's own
    expect(paths).toContain(join(root, "AGENTS.md")); // walked up from cwd (the host repo)
    expect(def.contextFiles.map((f) => f.content).join("\n")).toContain("Host repo spec");
  });

  // Note: AGENTS.md read errors no longer throw — ② context is sourced via pi's loadProjectContextFiles,
  // which warns and continues on an unreadable file (a deliberate deviation from fastagent's fail-visibly,
  // deferred with the ExecutionEnv/sandbox work; core.md §6). persona.md (below) still fails visibly.

  it("persona.md read errors other than not_found throw instead of silently dropping the persona", async () => {
    class DeniedEnv extends NodeExecutionEnv {
      override async readTextFile(path: string) {
        if (path.endsWith("persona.md")) {
          return err<string, FileError>(new FileError("permission_denied", "permission denied", path));
        }
        return super.readTextFile(path);
      }
    }
    const env = new DeniedEnv({ cwd: fixtureDir });
    await expect(loadAgentDefinition(fixtureDir, { env })).rejects.toThrow(
      /cannot read .*persona\.md.*permission denied/,
    );
  });

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
    expect(pdf?.content).toContain("pypdf"); // the full SKILL.md body is loaded (for activation)

    // Progressive disclosure: name + description in the startup prompt; the body is deferred.
    const prompt = assembleSystemPrompt({
      base: piBasePrompt(),
      contextFiles: def.contextFiles,
      skills: def.skills,
    });
    expect(prompt).toContain("<name>pdf</name>");
    expect(prompt).toContain("PDF files"); // description disclosed at stage 1
    expect(prompt).not.toContain("pypdf"); // body NOT disclosed until the skill activates
  });
});

describe("create: assembleSystemPrompt (four segments)", () => {
  it("base + <project_instructions> + skills listing + env context", async () => {
    const def = await loadAgentDefinition(fixtureDir);
    const prompt = assembleSystemPrompt({
      base: piBasePrompt(), // required: base and toolset must agree, no silent default
      contextFiles: def.contextFiles,
      skills: def.skills,
      cwd: "/work",
    });
    // (1) base (inherited from the pi engine)
    expect(prompt).toContain("operating inside pi");
    // (2) instructions injected wrapped (not pasted bare)
    expect(prompt).toContain("<project_instructions");
    expect(prompt).toContain("Haiku Bot");
    // ③ skills listing
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("season-words");
    // ④ env context — cwd only; no date, by design: a date line would invalidate the provider prompt
    // cache (a prefix cache) for every session at each day boundary (mirrors pi ≥0.80.7).
    expect(prompt).toContain("Current working directory: /work");
    expect(prompt).not.toContain("Current date");
    // order: base before instructions, instructions before skills
    expect(prompt.indexOf("operating inside pi")).toBeLessThan(prompt.indexOf("<project_instructions"));
    expect(prompt.indexOf("</project_context>")).toBeLessThan(prompt.indexOf("<available_skills>"));
  });

  it("base can be overridden; empty instructions/skills blocks are omitted", () => {
    const prompt = assembleSystemPrompt({ base: "CUSTOM BASE" });
    expect(prompt).toContain("CUSTOM BASE");
    expect(prompt).not.toContain("operating inside pi"); // after override the engine base is gone
    expect(prompt).not.toContain("<project_instructions");
    expect(prompt).not.toContain("<available_skills>");
  });

  it("piBasePrompt renders the tool list from actual tools so base and toolset stay aligned", () => {
    const withTools = piBasePrompt({ tools: piAllCodingTools(process.cwd()) });
    expect(withTools).toContain("- read:");
    expect(withTools).toContain("- bash:");
    expect(piBasePrompt()).toContain("(none)");
  });

  it("a persona.md persona overrides the engine identity but keeps the tool list + guidelines", () => {
    const tools = piAllCodingTools(process.cwd());
    const persona = piBasePrompt({ tools, persona: "You are the Repo Bot." });
    expect(persona).toContain("You are the Repo Bot.");
    expect(persona).not.toContain("operating inside pi"); // default identity replaced
    expect(persona).toContain("- read:"); // tools list kept
    expect(persona).toContain("Be concise"); // guidelines kept
    expect(piBasePrompt({ tools, persona: "   " })).toContain("operating inside pi"); // blank persona → default

    // In a full assembly the persona is ① and AGENTS.md remains ② <project_instructions>.
    const prompt = assembleSystemPrompt({
      base: persona,
      contextFiles: [{ path: "/x/AGENTS.md", content: "PROJECT CONTEXT LINE" }],
    });
    expect(prompt.indexOf("Repo Bot")).toBeLessThan(prompt.indexOf("<project_instructions"));
    expect(prompt).toContain("PROJECT CONTEXT LINE");
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
        seenSystemPrompt = context.systemPrompt;
        seenTools = (context.tools ?? []).map((t) => t.name);
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
  it("resolves a model spec string and sends instructions verbatim — no engine base prepended", async () => {
    let seen: string | undefined;
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen = ctx.systemPrompt;
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
    expect((seen ?? "").split("\nCurrent working directory:")[0]).toBe("You are a support bot.");
    expect(seen).not.toContain("operating inside pi"); // no engine identity forced on a hand-built agent
  });

  it("cannot activate a coding tool omitted from its replacement set", async () => {
    let activated: string[] | undefined;
    let offeredAfter: string[] = [];
    const { faux } = makeFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("try_enable_bash", {}, { id: "c1" })),
      (context) => {
        offeredAfter = (context.tools ?? []).map((tool) => tool.name);
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

  it("appends the skills listing when skills are mounted", async () => {
    let seen: string | undefined;
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen = ctx.systemPrompt;
        return fauxAssistantMessage("ok");
      },
    ]);
    const { skills } = await loadAgentDefinition(fixtureDir);
    const agent = createPiAgent({ providers: [faux.provider], model: "faux/faux-1", instructions: "P", skills });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    expect(seen).toContain("P");
    expect(seen).toContain("season-words"); // listed so the model can invoke it
  });

  it("no instructions → no coding base forced on a hand-built agent", async () => {
    let seen: string | undefined;
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen = ctx.systemPrompt;
        return fauxAssistantMessage("ok");
      },
    ]);
    const agent = createPiAgent({ providers: [faux.provider], model: "faux/faux-1" });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    // The invariant fastagent owns: a hand-built agent is never forced into pi's coding persona.
    // (pi fills its own neutral default; that exact string is pi's behavior, not our contract.)
    expect(seen).toBeDefined(); // a system prompt did reach the model — guards against a vacuous pass
    expect(seen).not.toContain("operating inside pi"); // no engine identity forced on a hand-built agent
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

  it("pi's read tool is rooted at the workspace it was built for", async () => {
    // The root is fixed at CONSTRUCTION now, not handed in per turn: these are pi-coding-agent's
    // tools, which take a cwd. Every caller builds them for the workspace the agent works on, so a
    // relative path resolves against that workspace and nothing else.
    const read = piAllCodingTools(fixtureDir).find((t) => t.name === "read")!;
    const r = await read.execute("t1", { path: "AGENTS.md" }, undefined, undefined, {} as never);
    const text = (r.content[0] as any).text as string;
    expect(text).toContain("Haiku Bot");
  });
});

describe("create L2: the directory is LIVE (definition re-read per invoke)", () => {
  it("an AGENTS.md/skill edit between two invokes reaches the next turn's prompt and skill resources — no restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-"));
    await writeFile(join(dir, "AGENTS.md"), "You are DRAFT-PERSONA.\n");
    const seen: (string | undefined)[] = [];
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen.push(ctx.systemPrompt);
        return fauxAssistantMessage("one");
      },
      (ctx) => {
        seen.push(ctx.systemPrompt);
        return fauxAssistantMessage("two");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1" });

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    // The edit an agent might make to its own workspace mid-conversation: new persona + a new skill.
    await writeFile(join(dir, "AGENTS.md"), "You are FINAL-PERSONA.\n");
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

  it("a persona.md edit between two invokes reaches the next turn's segment ① — no restart", async () => {
    // Guards the PR's wiring point: persona must come from the per-turn live() re-read, NOT a boot-time
    // closure value (the exact regression this PR fixes for `base`). If persona is hoisted out of live(),
    // seen[1] stays DRAFT-BOT and the last assertion fails.
    const dir = await mkdtemp(join(tmpdir(), "fa-live-persona-"));
    await writeFile(join(dir, "persona.md"), "You are DRAFT-BOT.\n");
    const seen: (string | undefined)[] = [];
    const { faux } = makeFaux();
    faux.setResponses([
      (ctx) => {
        seen.push(ctx.systemPrompt);
        return fauxAssistantMessage("one");
      },
      (ctx) => {
        seen.push(ctx.systemPrompt);
        return fauxAssistantMessage("two");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1" });

    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    await writeFile(join(dir, "persona.md"), "You are FINAL-BOT.\n");
    await collect(agent.invoke({ session: "s" }, { text: "again" }));

    expect(seen[0]).toContain("DRAFT-BOT");
    expect(seen[0]).not.toContain("operating inside pi"); // persona overrides the default engine identity
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

  it("a throw-class broken edit fails THAT turn as a failed event — the agent survives and the next good turn recovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-throw-"));
    await writeFile(join(dir, "AGENTS.md"), "You are a bot.\n");
    class FlakyEnv extends NodeExecutionEnv {
      deny = false;
      override async readTextFile(path: string) {
        if (this.deny && path.endsWith("persona.md")) {
          return err<string, FileError>(new FileError("permission_denied", "permission denied", path));
        }
        return super.readTextFile(path);
      }
    }
    const env = new FlakyEnv({ cwd: dir });
    const { faux } = makeFaux();
    faux.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("recovered")]);
    const { agent } = await createPiAgentFromDefinition(dir, { providers: [faux.provider], model: "faux/faux-1", env });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    env.deny = true; // the live re-read now throws (unreadable persona.md)
    const events: string[] = [];
    let details = "";
    for await (const e of agent.invoke({ session: "s" }, { text: "again" })) {
      events.push(e.type);
      if (e.type === "failed") details = e.details;
    }
    expect(events).toEqual(["failed"]); // SPEC MUST 2: a failed event, not a thrown iteration error
    expect(details).toMatch(/persona\.md/);

    env.deny = false; // the next good edit heals it — same agent, no restart
    const { text } = await collect(agent.invoke({ session: "s" }, { text: "back" }));
    expect(text).toBe("recovered");
  });
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
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
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

describe("create L2: the workspace roots the tools, the env reads the definition", () => {
  it("keeps `cwd` and a custom `env` apart, through the assembled agent", async () => {
    // Two directories doing two jobs. `cwd` is the workspace: where read/bash/edit/write land AND
    // whose ancestors carry ② project context. `env` is the IO the loader uses. Reading either root
    // off the other silently points half the agent at the wrong directory, and only a caller passing
    // both would ever notice — so this drives the real agent instead of re-calling the helpers.
    const workspace = await mkdtemp(join(tmpdir(), "fa-ws-"));
    const definitionDir = await mkdtemp(join(tmpdir(), "fa-def-"));
    await writeFile(join(workspace, "AGENTS.md"), "# Workspace context\n\nThe marker is FROM-WORKSPACE.\n");
    await writeFile(join(workspace, "marker.txt"), "READ-FROM-WORKSPACE\n");
    await writeFile(join(definitionDir, "persona.md"), "You are terse.\n");
    await writeFile(join(definitionDir, "marker.txt"), "READ-FROM-DEFINITION-DIR\n");

    const { faux } = makeFaux();
    let systemPrompt = "";
    // First turn: call `read` on a bare relative path. Whichever root the tool was built for is the
    // one that resolves it, and each directory holds a different file at that name.
    faux.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return {
          ...fauxAssistantMessage(""),
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "marker.txt" } }],
        } as ReturnType<typeof fauxAssistantMessage>;
      },
      fauxAssistantMessage("done"),
    ]);
    const { agent, definition } = await createPiAgentFromDefinition(definitionDir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      cwd: workspace,
      env: new NodeExecutionEnv({ cwd: definitionDir }),
    });
    // The BOOT snapshot (what callers report diagnostics from) walked the workspace.
    expect(JSON.stringify(definition.contextFiles)).toContain("FROM-WORKSPACE");

    const events = [];
    for await (const e of agent.invoke({ session: "s" }, { text: "hi" })) events.push(e);
    // THE tool actually ran, against the workspace root it was built for.
    const toolText = JSON.stringify(events);
    expect(toolText).toContain("READ-FROM-WORKSPACE");
    expect(toolText).not.toContain("READ-FROM-DEFINITION-DIR");

    // ...and so did the LIVE re-read that actually reaches the model.
    expect(systemPrompt).toContain("FROM-WORKSPACE");
    // And the model is told the SAME root its tools resolve against — naming the loader's directory
    // as the working directory would be a lie the model has no way to detect.
    expect(systemPrompt).toContain(workspace);
    expect(systemPrompt).not.toContain(definitionDir);
  });
});

describe("create L2: explicit tools replace the coding defaults", () => {
  it("keeps omitted built-ins inactive — the model is never offered one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-l2-tools-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    const { faux } = makeFaux();
    let assembly!: PiAssemblyParts;
    await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: piAllCodingTools(dir).filter((tool) => tool.name === "read"),
      onAssembly: (parts) => {
        assembly = parts;
      },
    });

    const session = await assembly.sessionFactory("s");
    // ACTIVE is the property that matters: what the model is offered and may call. The registry may
    // hold more than we passed — pi 0.84.3 keeps its own `powershell` there — but nothing we omitted
    // is ever ACTIVATED, and that is the guarantee. What the model actually receives is asserted in
    // the systemPrompt test above.
    expect(session.getActiveToolNames()).toEqual(["read"]);
    session.setActiveToolsByName(["read", "bash", "write"]);
    expect(session.getActiveToolNames()).toEqual(["read"]);
  });

  it("does not claim a coding surface it did not mount", async () => {
    // Reporting a capability set derived from "was `tools` passed?" rather than from the tools told
    // the model it could execute commands and edit files while none of that was mounted. It has no
    // way to find out except by trying.
    const dir = await mkdtemp(join(tmpdir(), "fa-identity-"));
    await writeFile(join(dir, "persona.md"), "");
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
      tools: piAllCodingTools(dir).filter((t) => t.name === "read" || t.name === "grep"),
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(prompt).toContain("- read:");
    expect(prompt).toContain("- grep:");
    expect(prompt).not.toContain("- bash:");
    // ...and the identity is the capability-neutral one, not pi's "executing commands, editing code".
    expect(prompt).not.toContain("executing commands");
  });
});

describe("skills/: a plain note is not a broken skill", () => {
  it("ignores a root .md without skill frontmatter, and still loads the real one", async () => {
    // Our own scaffold ships one (writing-great-skills/GLOSSARY.md). Before pi 0.84.3 every such file
    // produced an `invalid_metadata` diagnostic on every start — a warning the author could not act on.
    const dir = await mkdtemp(join(tmpdir(), "fa-skills-note-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
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
