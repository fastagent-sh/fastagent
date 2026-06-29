import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { makeFaux } from "./faux.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FileError, err } from "@earendil-works/pi-agent-core";
import {
  collect,
  createPiAgent,
  createPiAgentFromDefinition,
  loadAgentDefinition,
  piBasePrompt,
  piDefaultTools,
  type CreatePiAgentFromDefinitionOptions,
} from "../src/index.ts";
import { assembleSystemPrompt } from "../src/engines/pi/create.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agent");

describe("definition: loadAgentDefinition", () => {
  it("loads instructions from AGENTS.md and skills from SKILL.md frontmatter", async () => {
    const def = await loadAgentDefinition(fixtureDir);
    expect(def.instructions).toContain("Haiku Bot");
    expect(def.instructions).toContain("5-7-5");
    expect(def.dir).toBe(fixtureDir); // AGENTS.md path is derivable: join(dir, "AGENTS.md")
    expect(def.skills).toHaveLength(1);
    expect(def.skills[0]!.name).toBe("season-words");
    expect(def.skills[0]!.description).toContain("kigo");
    expect(def.diagnostics).toHaveLength(0);
  });

  it("missing AGENTS.md / skills returns undefined instructions and empty skills without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-empty-definition-"));
    const def = await loadAgentDefinition(dir);
    expect(def.instructions).toBeUndefined();
    expect(def.skills).toEqual([]);
  });

  it("skips a skill whose SKILL.md has no description and surfaces it as a diagnostic (not a crash)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-bad-skill-"));
    await mkdir(join(dir, "skills", "bad"), { recursive: true });
    await writeFile(join(dir, "skills", "bad", "SKILL.md"), "---\nname: bad\n---\nno description.\n");
    const def = await loadAgentDefinition(dir);
    expect(def.skills).toEqual([]); // the malformed skill is skipped, not loaded
    expect(JSON.stringify(def.diagnostics)).toMatch(/description/); // and surfaced, not silently dropped
  });

  it("AGENTS.md read errors other than not_found throw instead of silently becoming missing instructions", async () => {
    class DeniedEnv extends NodeExecutionEnv {
      override async readTextFile(path: string) {
        if (path.endsWith("AGENTS.md")) {
          return err<string, FileError>(new FileError("permission_denied", "permission denied", path));
        }
        return super.readTextFile(path);
      }
    }
    const env = new DeniedEnv({ cwd: fixtureDir });
    await expect(loadAgentDefinition(fixtureDir, { env })).rejects.toThrow(
      /cannot read .*AGENTS\.md.*permission denied/,
    );
  });

  it("loads only the definition's own skills/ — no external or global mount (your folder is the agent)", async () => {
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
      instructions: def.instructions,
      instructionsPath: join(dir, "AGENTS.md"),
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
      instructions: def.instructions,
      instructionsPath: join(fixtureDir, "AGENTS.md"),
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
    // ④ env context
    expect(prompt).toContain("Current working directory: /work");
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
    const withTools = piBasePrompt({ tools: piDefaultTools(fixtureDir) });
    expect(withTools).toContain("- read:");
    expect(withTools).toContain("- bash:");
    expect(piBasePrompt()).toContain("(none)");
  });
});

describe("create L2: types only promise options the implementation honors", () => {
  it("L2 options do not accept skills/instructions because they come from the definition directory", () => {
    const base: CreatePiAgentFromDefinitionOptions = { model: "p/m" };
    expect(base.model).toBeDefined();
    // @ts-expect-error -- skills must come from the definition folder, not the caller
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
    // default = pi core toolset (fidelity); custom code tools = explicit tools: injection, no magic dir
    expect(seenTools.sort()).toEqual(["bash", "edit", "read", "write"]);
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
    expect(seen).toBe("You are a support bot."); // verbatim: instructions ARE the prompt
    expect(seen).not.toContain("operating inside pi"); // no coding base (that is L2/folder fidelity)
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
    expect(seen).not.toContain("operating inside pi");
  });
});

describe("create: toolset (real pi tools, fidelity)", () => {
  it("piDefaultTools are pi core four tools (same as pi default)", () => {
    expect(
      piDefaultTools(fixtureDir)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["bash", "edit", "read", "write"]);
  });

  it("pi's read tool can read the fixture (same behavior as local pi)", async () => {
    const read = piDefaultTools(fixtureDir).find((t) => t.name === "read")!;
    const r = await read.execute("t1", { path: "AGENTS.md" });
    const text = (r.content[0] as any).text as string;
    expect(text).toContain("Haiku Bot");
  });
});
