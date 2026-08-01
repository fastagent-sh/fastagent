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
import { crc32, deflateSync } from "node:zlib";
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

/** A noisy PNG of `side`x`side` — noisy so it does not compress away, i.e. big enough to exercise the
 *  resize path rather than passing through untouched. */
function pngFixture(side: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const rows: Buffer[] = [];
  let seed = 1;
  for (let y = 0; y < side; y++) {
    const row = Buffer.alloc(1 + side * 3);
    for (let i = 1; i < row.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      row[i] = seed & 0xff;
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows), { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 1x1 BMP — a format neither provider takes inline, so it must be CONVERTED or dropped. */
function bmpFixture(): Buffer {
  const px = Buffer.from([0xff, 0x00, 0x00, 0x00]);
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + px.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(1, 18);
  header.writeInt32LE(1, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(px.length, 34);
  return Buffer.concat([header, px]);
}

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
    // IMAGES are where they diverge for free: core's `read` does nothing with one unless a processor is
    // injected (read-image.ts rebuilds pi's from its public halves). Left out, this is what breaks —
    // measured on a 5.6MB PNG: 7.48MB of raw base64 instead of 3.48MB of resized JPEG, and no dimension
    // note for the model's coordinate math. A format needing CONVERSION (bmp) is dropped outright, while
    // the description asserted identical above still advertises it.
    await writeFile(join(dir, "img.png"), pngFixture(120));
    await writeFile(join(dir, "img.bmp"), bmpFixture());
    await agree("read", { path: "img.png" });
    await agree("read", { path: "img.bmp" });
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
