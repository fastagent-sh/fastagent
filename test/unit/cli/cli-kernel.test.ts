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
    const r = await parse(["schedules", "rnu"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command 'rnu'/);
    expect(r.err).toMatch(/run/); // did-you-mean
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end through cli.ts: the delegation seam (kernel commands bypass the legacy parseArgs).

/** An extension's `./cli` entry: it says what it was given, or fails as its `fixture.json` says. */
const EXTENSION_CLI = `import { readFileSync } from "node:fs";
const { name, fails } = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));
export async function run(args) {
  if (fails) throw new Error(fails);
  console.log(JSON.stringify({ from: name, args }));
}
`;

describe("cli: a command an installed extension adds", () => {
  /** A project with `packages` installed: each a `./cli` entry that says what it was given, or fails with `fails`. */
  async function project(packages: Record<string, { fails?: string }>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fa-extension-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "agent", type: "module" }));
    for (const [name, { fails }] of Object.entries(packages)) {
      const at = join(dir, "node_modules", name);
      await mkdir(at, { recursive: true });
      await writeFile(
        join(at, "package.json"),
        JSON.stringify({ name, type: "module", exports: { "./cli": "./cli.js" } }),
      );
      await writeFile(join(at, "fixture.json"), JSON.stringify({ name, fails }));
      await writeFile(join(at, "cli.js"), EXTENSION_CLI);
    }
    return dir;
  }

  it("runs the agent's own @fastagent-sh/<name>, given every argument after its name, and says why it failed", async () => {
    const dir = await project({ "@fastagent-sh/demo": {}, "@fastagent-sh/broken": { fails: "no cluster here" } });
    const ran = await runInProcess(["demo", "init", "--target", "prod"], dir);
    expect([ran.code, JSON.parse(ran.stdout)]).toEqual([
      0,
      { from: "@fastagent-sh/demo", args: ["init", "--target", "prod"] },
    ]);
    const failed = await runInProcess(["broken", "deploy"], dir);
    expect([failed.code, failed.stderr.trim()]).toEqual([1, "Error: no cluster here"]);
  });

  it("names the package to install for a command none adds, and a typo stays a typo", async () => {
    const dir = await project({});
    const missing = await runInProcess(["agentcore", "init"], dir);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("unknown command 'agentcore'");
    expect(missing.stderr).toContain(
      "install @fastagent-sh/agentcore in the agent, with npm i @fastagent-sh/agentcore",
    );
    const typo = await runInProcess(["dve"], dir);
    expect(typo.stderr).toMatch(/Did you mean dev\?/);
    expect(typo.stderr).not.toContain("npm i");
  });

  it("never runs a package outside the @fastagent-sh scope, however the name is spelled", async () => {
    const dir = await project({ demo: {}, "@other/demo": {} });
    for (const name of ["../demo", "../../demo", "..%2fdemo", "@other/demo"]) {
      const refused = await runInProcess([name], dir);
      expect([name, refused.code, refused.stdout]).toEqual([name, 2, ""]);
    }
  });

  it("global -C <dir> selects the agent directory before extension lookup and built-in commands, and refuses bad paths", async () => {
    const dir = await project({ "@fastagent-sh/demo": {} });
    const nested = join(dir, "sub");
    await mkdir(nested, { recursive: true });
    // Extension lookup runs in `-C <dir>` from outside `dir`, and strips `-C` before handing off.
    const ext = await runInProcess(["-C", dir, "demo", "init"]);
    expect([ext.code, JSON.parse(ext.stdout)]).toEqual([0, { from: "@fastagent-sh/demo", args: ["init"] }]);
    // Attached `-C<dir>` and chained `-C a -C b` work sequentially like `git -C`.
    const attached = await runInProcess([`-C${dir}`, "demo", "ping"]);
    expect([attached.code, JSON.parse(attached.stdout)]).toEqual([0, { from: "@fastagent-sh/demo", args: ["ping"] }]);
    const chained = await runInProcess(["-C", nested, "-C", "..", "demo", "ping"]);
    expect([chained.code, JSON.parse(chained.stdout)]).toEqual([0, { from: "@fastagent-sh/demo", args: ["ping"] }]);
    // `-C` inside a subcommand's own args is NOT consumed as a global prefix.
    const subArg = await runInProcess(["-C", dir, "demo", "-C", "kept"]);
    expect([subArg.code, JSON.parse(subArg.stdout)]).toEqual([0, { from: "@fastagent-sh/demo", args: ["-C", "kept"] }]);
    // Missing or nonexistent `-C` is a usage error (exit 2, clean stdout).
    const missing = await runInProcess(["-C"]);
    expect([missing.code, missing.stdout]).toEqual([2, ""]);
    expect(missing.stderr).toContain("option '-C <dir>' argument missing");
    const nope = await runInProcess(["-C", join(dir, "no-such-dir"), "info"]);
    expect([nope.code, nope.stdout]).toEqual([2, ""]);
    expect(nope.stderr).toContain("-C ");
    // Documented in root --help.
    const help = await parse(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("-C <dir>");
  });
});
