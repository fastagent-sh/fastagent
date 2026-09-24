/**
 * PLACEMENT and the neutral path helpers (src/paths.ts): engine-neutral by nature, so their spec lives
 * here rather than inside the config or scaffold suites that used to own the rule.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { displayPath, placementDeadEnd, readTextIfExists, resolvePlacement } from "../src/paths.ts";

describe("paths: resolvePlacement — one marker; the workspace is the agent's parent", () => {
  const config = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  };

  it("the agent is the config holder one level inside; the workspace is its parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-"));
    await config(join(dir, "fastagent"));
    expect(resolvePlacement(dir)).toEqual({ agentDir: join(dir, "fastagent"), workspace: dir });
  });

  // Skipped as root, where there is no such thing as a directory the process cannot enter.
  const asUser = process.getuid?.() === 0 ? it.skip : it;
  asUser("a directory it cannot LOOK INTO is a permission error, never 'no agent here'", async () => {
    // The dangerous direction: `existsSync` answers false for EACCES too, so an agent behind a directory the
    // caller cannot enter was reported as absent — and the refusal for absent ends in `run \`fastagent init\`
    // to scaffold one`, over a definition that is already there.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-perm-"));
    await config(join(dir, "fastagent"));
    await chmod(join(dir, "fastagent"), 0o000);
    try {
      // The definition IS there, so the refusal must name the directory hiding it — and say to check it
      // before taking the `fastagent init` way out, which would scaffold over an agent nobody can see.
      expect(() => resolvePlacement(dir)).toThrow(/could not be read \(permission\), so an agent may be inside/);
      expect(() => resolvePlacement(dir)).toThrow(
        /: fastagent. Check those first; run `fastagent init` to scaffold one only if none/,
      );
      // Pointed AT the unreadable agent, not at its parent: a NAMED directory, so the errno itself travels.
      expect(() => resolvePlacement(join(dir, "fastagent"))).toThrow(/EACCES/);
    } finally {
      await chmod(join(dir, "fastagent"), 0o755);
    }
  });

  asUser("a directory it cannot look into never outranks a message that says what to DO", async () => {
    // Two agents and no way to pick: telling the caller to fix a third directory's permissions does not
    // resolve that, and fixing it would not change the answer.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-many-"));
    await config(join(dir, "alpha"));
    await config(join(dir, "beta"));
    await mkdir(join(dir, "locked"));
    await chmod(join(dir, "locked"), 0o000);
    try {
      expect(() => resolvePlacement(dir, {})).toThrow(/holds 2 agents \(alpha, beta\)/);
      expect(() => resolvePlacement(dir, { FASTAGENT_AGENT: "gamma" })).toThrow(/FASTAGENT_AGENT asserts "gamma"/);

      // And the weaker question keeps its old answer: `login` asks whether it is outside an agent, for which a
      // neighbour it may not enter is environment noise — answering it exits instead of logging in globally.
      const empty = await mkdtemp(join(tmpdir(), "fa-ws-noise-"));
      await mkdir(join(empty, "locked"));
      await chmod(join(empty, "locked"), 0o000);
      try {
        expect(placementDeadEnd(empty, {})).toBeUndefined();
        expect(() => resolvePlacement(empty, {})).toThrow(/could not be read \(permission\)/);
        // The way out SURVIVES the note: an unreadable neighbour on a shared machine is not a reason to
        // withhold the only line that says what to do here.
        expect(() => resolvePlacement(empty, {})).toThrow(/run `fastagent init` to scaffold one/);
      } finally {
        await chmod(join(empty, "locked"), 0o755);
      }
    } finally {
      await chmod(join(dir, "locked"), 0o755);
    }
  });

  it("a failure that is NOT about permissions surfaces as itself", async () => {
    // The scan swallows "someone else's 0700 directory" because that is normal on a shared machine. ELOOP is
    // not: it has a different fix, and calling it a permission problem sends the caller to chmod something
    // that is not broken. (A self-referential symlink is the cheapest real one — statSync gives up on it.)
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-loop-"));
    await symlink(join(dir, "loop"), join(dir, "loop"));
    expect(() => resolvePlacement(dir, {})).toThrow(/ELOOP/);
    expect(() => resolvePlacement(dir, {})).not.toThrow(/could not be read \(permission\)/);
  });

  asUser("the list of unreadable directories is bounded", async () => {
    // `/tmp` on a shared machine: a dozen `systemd-private-*` and `snap-private-tmp` entries, none of them an
    // agent. Printing every one buries the line that says what to do.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-many-locked-"));
    const locked = ["a", "b", "c", "d", "e"].map((n) => join(dir, n));
    for (const d of locked) {
      await mkdir(d);
      await chmod(d, 0o000);
    }
    try {
      expect(() => resolvePlacement(dir, {})).toThrow(/5 directories here could not be read/);
      expect(() => resolvePlacement(dir, {})).toThrow(/a, b, c, \+2 more/);
    } finally {
      for (const d of locked) await chmod(d, 0o755);
    }
  });

  asUser("an unreadable NEIGHBOUR does not fail a scan that found the agent", async () => {
    // Every machine has directories this process may not enter, and one sitting next to the agent must not fail a
    // scan that found it.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-neighbour-"));
    await config(join(dir, "fastagent"));
    await mkdir(join(dir, "locked"));
    await chmod(join(dir, "locked"), 0o000);
    try {
      expect(resolvePlacement(dir)).toEqual({ agentDir: join(dir, "fastagent"), workspace: dir });
    } finally {
      await chmod(join(dir, "locked"), 0o755);
    }
  });

  it("the NAME does not decide what IS an agent — the directory can be called anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-name-"));
    await config(join(dir, "reviewer"));
    expect(resolvePlacement(dir)).toEqual({ agentDir: join(dir, "reviewer"), workspace: dir });
    // …and a directory NAMED fastagent with no config is not an agent: one file decides it, everywhere.
    const plain = await mkdtemp(join(tmpdir(), "fa-ws-plain-"));
    await mkdir(join(plain, "fastagent", "tools"), { recursive: true });
    expect(() => resolvePlacement(plain)).toThrow(/not a fastagent agent/);
  });

  it("pointing AT the agent or at its parent gives the same placement", async () => {
    // Where the command runs must not change what the agent works on: `cd fastagent && fastagent dev` and
    // `fastagent dev` in the project both work on the project.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-aim-"));
    const agent = join(dir, "fastagent");
    await config(agent);
    expect(resolvePlacement(dir)).toEqual({ agentDir: agent, workspace: dir });
    expect(resolvePlacement(agent)).toEqual({ agentDir: agent, workspace: dir });
  });

  it("SEVERAL agents on one workspace: FASTAGENT_AGENT picks, the default NAME breaks the tie", async () => {
    // The shape this supports: an engineer's, a PM's and a content owner's agent driving one repository,
    // all with that repository as their workspace. Selection is per-person, so it lives in the
    // environment (a shell, an .envrc) — never in a committed file, which is shared by construction.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-many-"));
    await config(join(dir, "content"));
    await config(join(dir, "pm"));
    const pick = (v?: string) => resolvePlacement(dir, v === undefined ? {} : { FASTAGENT_AGENT: v });

    expect(pick("pm")).toEqual({ agentDir: join(dir, "pm"), workspace: dir });
    expect(pick("content").agentDir).toBe(join(dir, "content"));
    // Nothing selects: refuse and name them — never serve an arbitrary one.
    expect(() => pick()).toThrow(/holds 2 agents \(content, pm\) and none of them is named "fastagent"/);
    // Naming a missing one is a different mistake: echo the value back rather than restate the rule.
    expect(() => pick("nope")).toThrow(/FASTAGENT_AGENT asserts "nope", which is not one of them/);

    // The default name is the tie-break, so adding an agent to a working `<ws>/fastagent/` setup does
    // not break the command everyone already types. It decides only WHICH — never what IS an agent.
    await config(join(dir, "fastagent"));
    expect(pick().agentDir).toBe(join(dir, "fastagent"));
    expect(pick("pm").agentDir).toBe(join(dir, "pm")); // …and the env still outranks it

    // Pointed at directly, each still works on the shared workspace.
    expect(resolvePlacement(join(dir, "pm"))).toEqual({ agentDir: join(dir, "pm"), workspace: dir });
  });

  it("FASTAGENT_AGENT ASSERTS — a directory without that agent resolves to nothing, even holding one", async () => {
    // Serving a DIFFERENT agent than the one asked for is the silent wrong-target refused everywhere
    // else here, so the rule does not change meaning with the sibling count. The cost is stated in the
    // message: a value exported in a shell profile travels, and the way out is to scope it per-repo.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-one-"));
    await config(join(dir, "only"));
    expect(resolvePlacement(dir, {}).agentDir).toBe(join(dir, "only"));
    expect(() => resolvePlacement(dir, { FASTAGENT_AGENT: "other" })).toThrow(
      /holds 1 agent \(only\), and FASTAGENT_AGENT asserts "other".*\.envrc/s,
    );
    // An empty value is not an assertion (an unset-looking export must not refuse everything).
    expect(resolvePlacement(dir, { FASTAGENT_AGENT: "" }).agentDir).toBe(join(dir, "only"));
    // Where there is no agent at all, the env is not to blame — the generic refusal stands.
    const bare = await mkdtemp(join(tmpdir(), "fa-ws-bare-"));
    expect(() => resolvePlacement(bare, { FASTAGENT_AGENT: "x" })).toThrow(/is not a fastagent agent/);
  });

  it("the scan is ONE level: a grandchild agent is its own workspace, not this one's agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-deep-"));
    await config(join(dir, "packages", "reviewer"));
    expect(() => resolvePlacement(dir)).toThrow(/not a fastagent agent/);
    expect(resolvePlacement(join(dir, "packages"))).toEqual({
      agentDir: join(dir, "packages", "reviewer"),
      workspace: join(dir, "packages"),
    });
  });

  it("no config → not an agent: refuse with the way out, never guess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-none-"));
    expect(() => resolvePlacement(dir)).toThrow(/not a fastagent agent.*fastagent init/s);
    // A path that does not exist refuses the same way (a missing dir is not an error to raise here).
    expect(() => resolvePlacement(join(dir, "missing"))).toThrow(/not a fastagent agent/);

    // Standing INSIDE an agent (its tools/, skills/…) is the likeliest way to reach this refusal, and
    // "run `fastagent init`" is not the answer there — so it names the agent to `cd` to.
    await config(join(dir, "agent"));
    await mkdir(join(dir, "agent", "tools"), { recursive: true });
    expect(() => resolvePlacement(join(dir, "agent", "tools"))).toThrow(/is inside the agent .*but is not its root/);

    // …but ONLY when that ancestor really is an agent: the same marker resolution uses. A directory
    // holding no config must never be reported as "the agent you are in" — the `cd` would land here.
    await mkdir(join(dir, "checkout", "examples"), { recursive: true });
    expect(() => resolvePlacement(join(dir, "checkout", "examples"))).toThrow(/is not a fastagent agent/);
  });
});

describe("paths: displayPath", () => {
  it("displayPath: relative inside cwd, absolute when the target climbs out, nothing for cwd itself", () => {
    expect(displayPath("/a/b", "/a/b/x")).toBe("x"); // inside cwd → relative
    expect(displayPath("/a/b", "/a/b/..agent")).toBe("..agent"); // a dir literally named "..agent" is INSIDE cwd
    expect(displayPath("/a/b", "/a/b")).toBeUndefined(); // already in cwd → no cd step
    expect(displayPath("/a/b", "/tmp/x")).toBe("/tmp/x"); // outside → absolute, not ../../tmp/x noise
  });
});

describe("paths: readTextIfExists", () => {
  it("reads absence as undefined and anything else as the error it is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-read-"));
    await writeFile(join(dir, "present"), "hello");
    expect(await readTextIfExists(join(dir, "present"))).toBe("hello");
    expect(await readTextIfExists(join(dir, "absent"))).toBeUndefined();
    // A directory where the file should be is not "no file": a decision taken on absence (regenerate
    // it, skip its gate) would be wrong for something that is there.
    await expect(readTextIfExists(dir)).rejects.toThrow(/EISDIR/);
  });
});
