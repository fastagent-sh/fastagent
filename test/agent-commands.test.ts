/**
 * What an opened agent's `commands()` lists (create.ts `agentCommands`): the definition's skills, read live, the
 * resolved set rather than the files.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiAgentFromDir } from "../src/harnesses/pi/open.ts";
import { log } from "../src/log.ts";

describe("commands()", () => {
  it("a skill that failed to load is absent from commands() and warned once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sc-bad-"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(dir, "fastagent"), { recursive: true });
      await writeFile(
        join(dir, "fastagent", "fastagent.config.ts"),
        `export default { model: "openai-codex/gpt-5.5" };\n`,
      );
      const { agent: control } = await createPiAgentFromDir(join(dir, "fastagent"), {});
      // Broken AFTER boot — which is the case the read exists for: a finding already present at
      // startup was reported by the caller's boot report, and re-printing it is the spam the memo
      // prevents (test/report.test.ts pins that half).
      await mkdir(join(dir, "fastagent", "skills", "broken"), { recursive: true });
      await writeFile(join(dir, "fastagent", "skills", "broken", "SKILL.md"), `no frontmatter here\n`);
      // The broken file cannot be listed — so this read is the only place that can say it exists.
      expect((await control.commands()).filter((command) => command.source === "skill")).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toContain("broken");
      // … once: a composer opening twice must not spam a finding that has not changed.
      warn.mockClear();
      await control.commands();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("commands() re-reads the definition per call: added and removed skills, collisions first-wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sc-cmd-"));
    try {
      await mkdir(join(dir, "fastagent"));
      await writeFile(
        join(dir, "fastagent", "fastagent.config.ts"),
        `export default { model: "openai-codex/gpt-5.5" };\n`,
      );
      const { agent: control } = await createPiAgentFromDir(join(dir, "fastagent"), {});

      const skills = async () => (await control.commands()).filter((command) => command.source === "skill");
      // Empty is a complete answer …
      expect(await skills()).toEqual([]);
      // … and the read is LIVE, like the definition itself: a skill written while serving is
      // invocable on the next turn, so it must be listable NOW — a boot snapshot would advertise a
      // command set the running agent has already left behind.
      await mkdir(join(dir, "fastagent", "skills", "triage"), { recursive: true });
      await writeFile(
        join(dir, "fastagent", "skills", "triage", "SKILL.md"),
        `---\nname: triage\ndescription: Sort an inbox\n---\n\nDo the thing.\n`,
      );
      expect(await skills()).toEqual([{ name: "triage", description: "Sort an inbox", source: "skill" }]);
      // The RESOLVED set, which is the reason this read exists: a same-name collision is decided
      // first-wins at assembly, and a client reading the directory would list the name twice.
      await mkdir(join(dir, "fastagent", "skills", "triage-copy"), { recursive: true });
      await writeFile(
        join(dir, "fastagent", "skills", "triage-copy", "SKILL.md"),
        `---\nname: triage\ndescription: A second claim on the same name\n---\n\nDo it differently.\n`,
      );
      expect(await skills()).toEqual([{ name: "triage", description: "Sort an inbox", source: "skill" }]);
      // Live in BOTH directions — a cached read would only ever grow the list.
      await rm(join(dir, "fastagent", "skills"), { recursive: true, force: true });
      expect(await skills()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
