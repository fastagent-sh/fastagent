/**
 * The default coding tools are pi-agent-core's, which reach the machine through the ExecutionEnv the
 * harness hands them per turn — not pi-coding-agent's, which are the same four tools wired to `node:fs`
 * directly. That swap is only safe while the MODEL-facing surface is identical, because it is what the
 * agent is prompted with and what fastagent's channels render: the same names, the same descriptions,
 * the same parameter schemas, the same results.
 *
 * So this asserts the parity rather than trusting it, against BOTH implementations, and will fail the
 * day upstream lets them drift — which is exactly when the choice needs revisiting.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { piDefaultTools } from "../src/engines/pi/create.ts";

/** Either implementation, called uniformly — core's takes the tool context, the coding-agent's ignores it. */
type Executable = { execute: (...args: any[]) => Promise<unknown> };

/** What the MODEL sees of a tool — the whole contract this swap has to preserve. */
const surface = (t: { name: string; description?: unknown; parameters?: unknown }) => ({
  name: t.name,
  description: String(t.description),
  parameters: JSON.stringify(t.parameters),
});

describe("tools: pi-agent-core's env-backed defaults match pi-coding-agent's", () => {
  it("name, description and parameter schema are identical, tool for tool", () => {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const core = piDefaultTools().sort(byName).map(surface);
    const coding = createCodingTools(process.cwd()).sort(byName).map(surface);
    expect(core).toEqual(coding);
  });

  it("…and so are the results, on the paths an agent actually takes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-parity-"));
    await writeFile(join(dir, "f.txt"), "hello\n");
    const env = new NodeExecutionEnv({ cwd: dir });
    const core = Object.fromEntries(piDefaultTools().map((t) => [t.name, t]));
    const coding = Object.fromEntries(createCodingTools(dir).map((t) => [t.name, t]));
    // The env is the ONE argument that differs: core's tools take it as the turn's tool context, the
    // coding-agent's closed over `dir` when they were built. Same root, so the same answer. A throw is
    // captured rather than propagated — how a tool REPORTS trouble is most of what is being compared.
    const call = async (t: Executable, params: object, ctx: unknown) => {
      try {
        return JSON.stringify(await t.execute("t", params, undefined, undefined, ctx));
      } catch (e) {
        return `threw: ${(e as Error).message}`;
      }
    };
    // Read-only calls can run both implementations over the same input; MUTATING ones must not (the
    // second would see the first's edit), so those get a file each and are compared through `strip`.
    const agree = async (name: string, params: object) => {
      const a = await call(core[name]!, params, { env });
      const b = await call(coding[name]!, params, undefined);
      expect(a, `${name} ${JSON.stringify(params)}`).toBe(b);
    };

    await agree("read", { path: "f.txt" });
    await agree("bash", { command: "echo out; pwd" });
    // FAILURE paths matter more than success ones: the divergence this guards against is
    // pi-coding-agent's TUI rendering stack, which shows up in how a tool reports trouble.
    await agree("bash", { command: "echo out; echo err 1>&2; exit 1" });
    await agree("edit", { path: "f.txt", edits: [{ oldText: "absent", newText: "x" }] });

    const strip = (r: string) => r.replace(/[we][12]\.txt/g, "F");
    const w1 = await call(core.write!, { path: "w1.txt", content: "x" }, { env });
    const w2 = await call(coding.write!, { path: "w2.txt", content: "x" }, undefined);
    expect(strip(w1)).toBe(strip(w2));

    await writeFile(join(dir, "e1.txt"), "hello\n");
    await writeFile(join(dir, "e2.txt"), "hello\n");
    const edit = (p: string) => ({ path: p, edits: [{ oldText: "hello", newText: "bye" }] });
    const e1 = await call(core.edit!, edit("e1.txt"), { env });
    const e2 = await call(coding.edit!, edit("e2.txt"), undefined);
    expect(strip(e1)).toBe(strip(e2));
  });

  it("pins the two places they DO differ — cosmetic, and better seen than assumed", async () => {
    // Parity is the claim this swap rests on, so where it does not hold exactly, say where. Both of
    // these are wording, not information: same failure, same cause, same path. Should either grow into
    // a real difference, this test says so instead of a channel rendering it at a user.
    const dir = await mkdtemp(join(tmpdir(), "fa-parity-diff-"));
    const env = new NodeExecutionEnv({ cwd: dir });
    const core = Object.fromEntries(piDefaultTools().map((t) => [t.name, t]));
    const coding = Object.fromEntries(createCodingTools(dir).map((t) => [t.name, t]));
    const message = async (t: Executable, params: object, ctx: unknown) =>
      await t.execute("t", params, undefined, undefined, ctx).then(
        () => "(no throw)",
        (e: Error) => e.message,
      );

    // 1. A missing file: same ENOENT for the same path, named after a different syscall.
    const missing = { path: "nope.txt" };
    expect(await message(core.read!, missing, { env })).toMatch(/ENOENT.*open .*nope\.txt/);
    expect(await message(coding.read!, missing, undefined)).toMatch(/ENOENT.*access .*nope\.txt/);

    // 2. A failing command with NO output: the coding-agent tool says so in words, core's just reports
    //    the exit code. WITH output they are identical (asserted above), which is the case that matters.
    const silent = { command: "exit 3" };
    expect(await message(core.bash!, silent, { env })).toBe("Command exited with code 3");
    expect(await message(coding.bash!, silent, undefined)).toBe("(no output)\n\nCommand exited with code 3");
  });
});
