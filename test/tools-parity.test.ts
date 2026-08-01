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
    // coding-agent's closed over `dir` when they were built. Same root, so same answer.
    const run = async (name: string, params: object) => [
      await core[name]!.execute("t", params, undefined, undefined, { env }),
      await coding[name]!.execute("t", params, undefined, undefined),
    ];

    const [readCore, readCoding] = await run("read", { path: "f.txt" });
    expect(readCore).toEqual(readCoding);

    const [bashCore, bashCoding] = await run("bash", { command: "echo out; pwd" });
    expect(bashCore).toEqual(bashCoding);

    // write/edit mutate, so they get their own file each — compare the reported outcome, not the path.
    const strip = (r: unknown) => JSON.stringify(r).replace(/w[12]\.txt/g, "W");
    const [w1] = await run("write", { path: "w1.txt", content: "x" });
    const [, w2] = await run("write", { path: "w2.txt", content: "x" });
    expect(strip(w1)).toBe(strip(w2));
  });
});
