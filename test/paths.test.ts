/**
 * ADDRESSING and the neutral path helpers (src/paths.ts): harness-neutral by nature, so their spec lives here rather
 * than inside the config or scaffold suites.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { displayPath, findAgentDir, readTextIfExists, resolveAgentDir } from "../src/paths.ts";

describe("paths: resolveAgentDir — the agent is the directory named, holding fastagent.config.ts", () => {
  const config = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  };

  it("a directory holding the config IS the agent, whatever it is called", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agent-"));
    await config(join(dir, "anything"));
    expect(resolveAgentDir(join(dir, "anything"))).toBe(join(dir, "anything"));
  });

  it("nothing is searched for: an agent one level inside does not make its parent one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agent-parent-"));
    await config(join(dir, "fastagent"));
    expect(() => resolveAgentDir(dir)).toThrow(/is not a fastagent agent.*fastagent init <dir>/);
    expect(findAgentDir(dir)).toBeUndefined();
  });

  it("inside an agent is refused, naming its root — never the enclosing agent, never 'no agent'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-agent-inside-"));
    await config(join(dir, "agent"));
    await mkdir(join(dir, "agent", "tools"), { recursive: true });
    // `findAgentDir` too: `login` asks it, and "no agent here" would log in to the machine's store.
    for (const ask of [resolveAgentDir, findAgentDir]) {
      expect(() => ask(join(dir, "agent", "tools"))).toThrow(
        new RegExp(`is inside the agent ${join(dir, "agent")} — run from`),
      );
    }
    // …but ONLY when that ancestor really is an agent: a directory holding no config is simply not one.
    await mkdir(join(dir, "checkout", "examples"), { recursive: true });
    expect(() => resolveAgentDir(join(dir, "checkout", "examples"))).toThrow(/is not a fastagent agent/);
    expect(() => resolveAgentDir(join(dir, "missing"))).toThrow(/is not a fastagent agent/);
  });

  // Skipped as root, where there is no such thing as a directory the process cannot enter.
  const asUser = process.getuid?.() === 0 ? it.skip : it;
  asUser("a directory it cannot LOOK INTO is a permission error, never 'no agent here'", async () => {
    // `existsSync` answers false for EACCES too, so an agent behind a directory the caller cannot enter would read
    // as absent — and the refusal for absent ends in `fastagent init`, over a definition that is already there.
    const dir = await mkdtemp(join(tmpdir(), "fa-agent-perm-"));
    await config(join(dir, "fastagent"));
    await chmod(join(dir, "fastagent"), 0o000);
    try {
      expect(() => resolveAgentDir(join(dir, "fastagent"))).toThrow(/EACCES/);
    } finally {
      await chmod(join(dir, "fastagent"), 0o755);
    }
  });

  it("a failure that is NOT about absence surfaces as itself", async () => {
    // A self-referential symlink is the cheapest real one — statSync gives up on it with ELOOP.
    const dir = await mkdtemp(join(tmpdir(), "fa-agent-loop-"));
    await symlink(join(dir, "loop"), join(dir, "loop"));
    expect(() => resolveAgentDir(join(dir, "loop"))).toThrow(/ELOOP/);
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
