import { describe, expect, it } from "vitest";
import { buildCliProgram } from "../../../src/cli/program.ts";

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
    // An out-of-set argument is the parser's too, and names the set.
    const host = await parse(["deploy", "heroku"]);
    expect(host.code).toBe(2);
    expect(host.err).toMatch(/Allowed choices are docker, fly, railway/);
  });

  it("a mistyped subcommand suggests the real one and never runs it", async () => {
    const r = await parse(["content", "remvoe", "app"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command 'remvoe'/);
    expect(r.err).toMatch(/remove/); // did-you-mean
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end through cli.ts: the delegation seam (kernel commands bypass the legacy parseArgs).
