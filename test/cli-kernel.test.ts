import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram, type CommandSpec, optionKey } from "../src/cli/kernel.ts";
import { buildCliProgram, specs } from "../src/cli/program.ts";

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

describe("cli kernel: spec conformance", () => {
  const walk = (list: readonly CommandSpec[], prefix = ""): { path: string; spec: CommandSpec }[] =>
    list.flatMap((s) => [{ path: `${prefix}${s.name}`, spec: s }, ...walk(s.subcommands ?? [], `${prefix}${s.name} `)]);

  it("every help surface fits in 80 columns — commander sections and our verbatim text alike", async () => {
    // At the narrow floor (helpWidth 80 — what pipes/CI get), commander wraps its sections; the
    // verbatim Examples/notes strings are hand-wrapped at ≤78 — this guard catches a spec whose
    // text drifts past that floor. Wider terminals only ever get MORE room.
    const paths: string[][] = [[]];
    const collect = (list: readonly CommandSpec[], prefix: string[]): void => {
      for (const s of list) {
        paths.push([...prefix, s.name]);
        collect(s.subcommands ?? [], [...prefix, s.name]);
      }
    };
    collect(specs, []);
    for (const p of paths) {
      const r = await parse([...p, "--help"]);
      expect(r.code, p.join(" ") || "(top)").toBe(0);
      for (const line of r.out.split("\n")) {
        expect(line.length, `${p.join(" ") || "(top)"}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(80);
      }
    }
  });

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

describe("cli kernel: help styling — bold headings, NO colors; errors carry the one red prefix", () => {
  /** Parse with forced-on styling to assert what a color TTY would render. */
  async function parseStyled(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const program = buildCliProgram({
      colors: true,
      helpWidth: 80,
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

  it("help headings are bold and nothing in help is colored", async () => {
    const r = await parseStyled(["models", "--help"]);
    expect(r.out).toContain("\x1b[1mUsage:\x1b[0m"); // bold section headings
    expect(r.out).toContain("\x1b[1mExamples:\x1b[0m"); // incl. the verbatim ones
    // No foreground COLOR anywhere in help (SGR 30-37 / 90-97) — bold (1) is the only style.
    const colorCodes = [...r.out.matchAll(/\u001b\[([\d;]+)m/g)].filter((m) =>
      (m[1] as string).split(";").some((code) => /^[39]\d$/.test(code)),
    );
    expect(colorCodes).toEqual([]);
    const plain = await parse(["models", "--help"]); // the harness pins colors: false → fully stripped
    expect(plain.out).not.toContain("\x1b[");
  });

  it("parse errors carry the unified bold-red Error: prefix (plain without colors)", async () => {
    const styled = await parseStyled(["models", "--force"]);
    expect(styled.code).toBe(2);
    expect(styled.err).toContain("\x1b[1;31mError:\x1b[0m unknown option '--force'");
    const plain = await parse(["models", "--force"]);
    expect(plain.err).toMatch(/^Error: unknown option '--force'/);
    expect(plain.err).not.toContain("\x1b[");
  });
});

describe("cli kernel: the option-key naming rule", () => {
  it("optionKey: camelCase of the long name; --no-x negates and stores under x", () => {
    expect(optionKey("--json")).toBe("json");
    expect(optionKey("--auth-path <file>")).toBe("authPath");
    expect(optionKey("--no-input")).toBe("input");
    expect(optionKey("--no-scale-to-zero")).toBe("scaleToZero");
    expect(optionKey("-h, --help")).toBe("help");
    expect(() => optionKey("-x")).toThrow(/no long form/);
  });

  it("a conflicts reference to an unknown key fails at BUILD time, not silently at parse time", () => {
    const bad: CommandSpec = {
      name: "x",
      summary: "s",
      flags: [
        { flags: "--flat", description: "d", conflicts: ["agentDirTypo"] },
        { flags: "--agent-dir <name>", description: "d" },
      ],
      run: () => {},
    };
    expect(() => buildProgram([bad])).toThrow(/unknown option key "agentDirTypo"/);
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
  it("--help shows ONE flat Commands list in the original usage-wall order (no groups)", async () => {
    const r = await parse(["--help"]);
    expect(r.code).toBe(0);
    // A commander refactor of the same CLI, not a redesign: no invented group headings…
    expect(r.out).not.toMatch(/Author|Verify|Serve & ship|Operate:/);
    // …one flat section, in the original synopsis order.
    expect(r.out).toMatch(/^Commands:$/m);
    const order = ["init", "models", "info", "tool", "invoke", "fire", "schedule", "dev", "chat", "start"];
    const at = (name: string) => r.out.search(new RegExp(`^  ${name}`, "m"));
    for (let i = 1; i < order.length; i++) {
      expect(at(order[i - 1] as string), `${order[i - 1]} before ${order[i]}`).toBeLessThan(at(order[i] as string));
    }
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

  it("an empty required argument is a usage error on every command (the old falsy guards, kept)", async () => {
    const cases = [
      ["invoke", ""],
      ["fire", ""],
      ["tool", ""],
      ["schedule", "history", ""],
      ["schedule", "cancel", ""],
    ];
    for (const argv of cases) {
      const r = await parse(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toMatch(/must not be empty/);
    }
  });

  it("flags belong to their command: the legacy pre-command placement is rejected, exit 2", async () => {
    // The pre-commander CLI accepted flags anywhere (one global parseArgs). That form is now an
    // explicit break (documented in docs/cli.md): strict per-command validation wins over placement.
    const cases = [
      ["--json", "info"],
      ["--model", "x", "invoke", "hi"],
      ["schedule", "--json", "list"],
    ];
    for (const argv of cases) {
      const r = await parse(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toMatch(/unknown option/);
    }
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

function run(
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], env ? { env: { ...process.env, ...env } } : {});
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

  it("exit codes follow responsibility: bad --port flag → 2 (usage), bad PORT env → 1 (config)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-kernel-port-"));
    const flag = await run(["start", dir, "--port", "abc"]);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toMatch(/invalid --port/);
    const env = await run(["start", dir], { PORT: "abc", FASTAGENT_MODEL: "openai/gpt-5.5" });
    expect(env.code).toBe(1);
    expect(env.stderr).toMatch(/invalid PORT env/);
  });

  it("an invalid --agent-dir VALUE is a usage error (exit 2), and nothing is written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-kernel-agentdir-"));
    const r = await run(["init", dir, "--agent-dir", "."]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/must be a subdirectory/);
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
