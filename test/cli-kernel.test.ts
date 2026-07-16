import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram, type CommandSpec } from "../src/cli/kernel.ts";
import { specs } from "../src/cli/program.ts";

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
  const program = buildProgram(specs, {
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

describe("cli kernel: spec conformance", () => {
  const walk = (list: readonly CommandSpec[], prefix = ""): { path: string; spec: CommandSpec }[] =>
    list.flatMap((s) => [{ path: `${prefix}${s.name}`, spec: s }, ...walk(s.subcommands ?? [], `${prefix}${s.name} `)]);

  it("every spec has a one-line summary; every runnable spec has at least one example", () => {
    for (const { path, spec } of walk(specs)) {
      expect(spec.summary, path).toBeTruthy();
      expect(spec.summary, path).not.toContain("\n");
      if (spec.run)
        expect(spec.examples?.length ?? 0, `${path} needs an example (clig: lead with examples)`).toBeGreaterThan(0);
      else expect(spec.subcommands?.length ?? 0, `${path} is a group — needs subcommands`).toBeGreaterThan(0);
    }
  });
});

describe("cli kernel: help", () => {
  it("per-command help shows usage, arguments, and the Examples section (exit 0)", async () => {
    const r = await parse(["models", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage: fastagent models/);
    expect(r.out).toMatch(/Examples:/);
    expect(r.out).toMatch(/fastagent models claude/);
  });

  it("nested subcommand help works and shows its flags", async () => {
    const r = await parse(["schedule", "history", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage: fastagent schedule history/);
    expect(r.out).toMatch(/--json/);
  });

  it("`help <cmd>` is equivalent to `<cmd> --help`", async () => {
    const direct = await parse(["tool", "--help"]);
    const viaHelp = await parse(["help", "tool"]);
    expect(viaHelp.code).toBe(0);
    // help subcommand writes to stdout too; same body
    expect(viaHelp.out).toBe(direct.out);
  });
});

describe("cli kernel: the top-level surface", () => {
  it("--help shows the grouped overview (clig: most common commands first)", async () => {
    const r = await parse(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Author \(the iteration loop\):/);
    expect(r.out).toMatch(/Verify \(no server needed\):/);
    expect(r.out).toMatch(/Serve & ship:/);
    expect(r.out).toMatch(/Operate:/);
    // The author loop leads the listing — init before deploy.
    expect(r.out.indexOf("init")).toBeLessThan(r.out.indexOf("deploy"));
  });

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
  });

  it("a missing required argument is a usage error: exit 2", async () => {
    const r = await parse(["schedule", "cancel"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/missing required argument 'id'/);
  });

  it("a bare group command shows its subcommand help and exits 2", async () => {
    const r = await parse(["schedule"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage: fastagent schedule/);
    expect(r.err).toMatch(/history/);
  });

  it("a mistyped subcommand suggests the real one and never runs it", async () => {
    const r = await parse(["schedule", "cancle", "wake-1"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command 'cancle'/);
    expect(r.err).toMatch(/cancel/); // did-you-mean
  });

  it("an out-of-set <host> argument is rejected by the parser (choices)", async () => {
    const r = await parse(["deploy", "heroku"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Allowed choices are docker, fly, railway/);
  });

  it("conflicting flags are rejected by the parser (init --flat vs --agent-dir)", async () => {
    const r = await parse(["init", "--flat", "--agent-dir", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/'--flat' cannot be used with option '--agent-dir/);
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end through cli.ts: the delegation seam (kernel commands bypass the legacy parseArgs).

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], cwd ? { cwd } : {});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("cli end to end: the thin entry", () => {
  it("models --help renders the generated per-command help (exit 0)", async () => {
    const { code, stdout, stderr } = await run(["models", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Usage: fastagent models/);
    expect(stderr).toBe("");
  });

  it("schedule list on an empty dir reads cleanly: data to stdout, message to stderr, exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-kernel-sched-"));
    const { code, stdout, stderr } = await run(["schedule", "list", dir]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/nothing scheduled/);
  });

  it("schedule cancel on a missing wake-up exits 1 (runtime miss, not usage)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-kernel-cancel-"));
    const { code, stderr } = await run(["schedule", "cancel", "wake-nope", dir]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/no pending wake-up wake-nope/);
  });

  it("tool with no args is a usage error from the kernel: exit 2", async () => {
    const { code, stderr } = await run(["tool"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/missing required argument 'name'/);
  });

  it("tool with malformed JSON args exits 2 (usage class); an unknown tool stays a runtime miss (1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-kernel-tool-"));
    // "read" is a pi default tool — present in any workspace, so the failure is the JSON, not the name.
    const bad = await run(["tool", "read", "{not json", dir]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/invalid JSON args/);
    const missing = await run(["tool", "nope", "{}", dir]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/unknown tool "nope"/);
  });
});
