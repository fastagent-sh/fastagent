import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliProgram } from "../../../packages/fastagent/src/cli/program.ts";
import { runInProcess } from "../../doubles/cli-run.ts";

/**
 * The commander kernel: specs-as-data rendered through buildProgram. In-process tests drive the
 * program with injected IO (no spawn, no process.exit); a few spawn tests at the end verify the
 * cli.ts delegation wiring end to end.
 */

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Parse one invocation in-process; capture stdout/stderr chunks and the kernel's exit code. */
async function parse(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const program = buildCliProgram({
    helpWidth: 80, // the determinism seam: production adapts to the terminal (pipes fall back to 80)
    colors: false, // ditto: production detects per stream (TTY on; pipe/NO_COLOR/TERM=dumb off)
    out: (c) => {
      out += c;
    },
    err: (c) => {
      err += c;
    },
    exit: (code) => {
      throw new ExitSignal(code);
    },
  });
  let code = 0;
  try {
    await program.parseAsync(["node", "fastagent", ...argv]);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    code = e.code;
  }
  return { code, out, err };
}

describe("cli kernel: help", () => {
  it("per-command help shows usage, arguments, and the Examples section (exit 0)", async () => {
    const r = await parse(["models", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage: fastagent models/);
    expect(r.out).toMatch(/Examples:/);
    expect(r.out).toMatch(/fastagent models claude/);
  });
});

describe("cli kernel: the top-level surface", () => {
  it("a bare invocation shows the overview on stderr and exits 2 (missing command = usage)", async () => {
    const r = await parse([]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage: fastagent/);
  });
});

describe("cli kernel: exit-code policy (0 success, 2 usage)", () => {
  it("an unknown option is a usage error: exit 2, one actionable line", async () => {
    const r = await parse(["models", "--force"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown option '--force'/);
    expect(r.err).toMatch(/--help/); // the pointer, not the full help wall (signal-to-noise)
    expect(r.err).not.toMatch(/Usage: fastagent models \[options\]/);
    // A retired flag is just an unknown one (init --embedded is gone — nesting is the default).
    const retired = await parse(["init", "--embedded"]);
    expect(retired.code).toBe(2);
    expect(retired.err).toMatch(/unknown option '--embedded'/);
  });

  it("a mistyped subcommand suggests the real one and never runs it", async () => {
    const r = await parse(["deploy", "chcek"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command 'chcek'/);
    expect(r.err).toMatch(/check/); // did-you-mean
  });
});

describe("cli: global -C <dir> and unknown commands", () => {
  it("suggests near-miss built-in commands and exits 2 on unknown commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-cli-unknown-"));
    const typo = await runInProcess(["dve"], dir);
    expect([typo.code, typo.stdout]).toEqual([2, ""]);
    expect(typo.stderr).toMatch(/Did you mean dev\?/);

    const unknown = await runInProcess(["nonexistent-cmd"], dir);
    expect([unknown.code, unknown.stdout]).toEqual([2, ""]);
    expect(unknown.stderr).toContain("unknown command 'nonexistent-cmd'");
  });

  it("global -C <dir> selects the agent directory (including -C<dir> and chained -C), and refuses missing or nonexistent paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-cli-chdir-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "chdir-agent", type: "module" }));
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
    const nested = join(dir, "sub");
    await mkdir(nested, { recursive: true });

    const attached = await runInProcess([`-C${dir}`, "info", "--json"]);
    expect(attached.code, attached.stderr).toBe(0);
    expect(JSON.parse(attached.stdout).name).toBe("chdir-agent");

    const chained = await runInProcess(["-C", nested, "-C", "..", "info", "--json"]);
    expect(chained.code, chained.stderr).toBe(0);
    expect(JSON.parse(chained.stdout).name).toBe("chdir-agent");

    const missing = await runInProcess(["-C"]);
    expect([missing.code, missing.stdout]).toEqual([2, ""]);
    expect(missing.stderr).toContain("option '-C <dir>' argument missing");

    const nope = await runInProcess(["-C", join(dir, "no-such-dir"), "info"]);
    expect([nope.code, nope.stdout]).toEqual([2, ""]);
    expect(nope.stderr).toContain("-C ");

    const help = await parse(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("-C <dir>");
  });
});
