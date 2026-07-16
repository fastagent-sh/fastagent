/**
 * CLI kernel — commands as data. A {@link CommandSpec} carries everything the CLI surface needs
 * (summary, args/flags, examples, narrative notes, a lazy `run`), and {@link buildProgram} renders
 * the set through commander. Commander is an implementation detail of THIS module: specs and command
 * implementations never import it, so replacing the parser/help renderer stays a one-file change.
 *
 * Follows clig.dev: per-command help in four spellings (`-h`/`--help`/`help <cmd>`/bare-with-missing-args),
 * examples in help, "did you mean" suggestions (never auto-run), and one exit-code policy — 0 success,
 * 1 runtime failure (owned by the command bodies), 2 usage error (anything the parser itself rejects).
 */
import { Argument, Command, Option } from "commander";

/** One positional argument, in commander syntax: `<name>` required, `[dir]` optional. */
export interface ArgSpec {
  name: string;
  description: string;
  default?: string;
  /** Closed value set — the parser rejects anything else as a usage error (exit 2). */
  choices?: string[];
}

/** One flag, in commander syntax: `--json`, or `--auth-path <file>` for a value-taking flag. */
export interface FlagSpec {
  flags: string;
  description: string;
  /** Parses but does not appear in help — for retired flags that should still explain themselves. */
  hidden?: boolean;
  /** Mutually exclusive with these option names (camelCase) — the parser rejects the combination. */
  conflicts?: string[];
}

export interface ExampleSpec {
  cmd: string;
  note?: string;
}

export interface CommandSpec {
  name: string;
  /** One line for the command list in the parent help. */
  summary: string;
  /** Longer description for the command's own help; defaults to `summary`. */
  description?: string;
  /** Heading this command is listed under in the parent help (clig: most common commands first). */
  group?: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  /** Shown in an "Examples:" section of the command's help — clig: users reach for examples first. */
  examples?: ExampleSpec[];
  /** Narrative help (behavior, precedence rules, caveats) appended after the generated sections. */
  notes?: string;
  /** A group command (e.g. `schedule`) declares subcommands instead of `run`. */
  subcommands?: CommandSpec[];
  /**
   * The implementation: positional args in declaration order (an optional arg without a default is
   * `undefined`), then the parsed flags. Lazy-import the actual work so `fastagent <cmd>` pays only
   * for the modules that command uses. Runtime failures exit 1 from inside (fail visibly).
   */
  run?: (args: (string | undefined)[], flags: Record<string, unknown>) => Promise<void> | void;
}

/** Program-level configuration. Output/exit seams let tests drive the program in-process. */
export interface ProgramOptions {
  /** Printed by `-v`/`--version`. */
  version?: string;
  /** Appended after the top-level help (program examples, docs link). */
  helpTail?: string;
  out?: (chunk: string) => void;
  err?: (chunk: string) => void;
  exit?: (code: number) => never;
}

/** Build the commander program for `specs`. The CLI entry parses with it; tests inject the IO seams. */
export function buildProgram(specs: readonly CommandSpec[], options: ProgramOptions = {}): Command {
  const exit: (code: number) => never = options.exit ?? ((code) => process.exit(code));
  const program = new Command("fastagent");
  program.description("Serve a file-defined agent — persona.md, skills/, tools/, channels/ — as a live service.");
  // The exit-code policy: commander throws only for parse-level events — help/version displays carry
  // exitCode 0 (→ 0), everything else it rejects is a usage error (→ 2). Runtime failures never pass
  // through here; command bodies exit 1 themselves.
  program.exitOverride((err) => exit(err.exitCode === 0 ? 0 : 2));
  // Fixed 80-column help: deterministic across terminals/pipes/CI, and the width our verbatim
  // Examples/notes text is wrapped to — guarded by the ≤80-columns conformance test.
  program.configureHelp({ helpWidth: 80 });
  program.showSuggestionAfterError(); // "did you mean models?" — suggest only, never run it (clig on DWIM)
  program.showHelpAfterError("(run with --help for usage)");
  if (options.version) program.version(options.version, "-v, --version", "print the fastagent version");
  if (options.out || options.err) {
    program.configureOutput({
      ...(options.out ? { writeOut: options.out } : {}),
      ...(options.err ? { writeErr: options.err } : {}),
    });
  }
  if (options.helpTail) program.addHelpText("after", options.helpTail);
  // Subcommands inherit exitOverride/output/suggestion settings at .command() time — register last.
  for (const spec of specs) register(program, spec);
  return program;
}

function register(parent: Command, spec: CommandSpec): void {
  const cmd = parent.command(spec.name);
  cmd.summary(spec.summary);
  cmd.description(spec.description ?? spec.summary);
  if (spec.group) cmd.helpGroup(spec.group);
  for (const a of spec.args ?? []) {
    const arg = new Argument(a.name, a.description);
    if (a.default !== undefined) arg.default(a.default);
    if (a.choices) arg.choices(a.choices);
    cmd.addArgument(arg);
  }
  for (const f of spec.flags ?? []) {
    const opt = new Option(f.flags, f.description);
    if (f.hidden) opt.hideHelp();
    if (f.conflicts) opt.conflicts(f.conflicts);
    cmd.addOption(opt);
  }
  const extra = extraHelp(spec);
  if (extra) cmd.addHelpText("after", extra);
  for (const sub of spec.subcommands ?? []) register(cmd, sub);
  const run = spec.run;
  if (run) {
    cmd.action(async (...invocation: unknown[]) => {
      invocation.pop(); // the Command instance
      const flags = invocation.pop() as Record<string, unknown>;
      await run(invocation as (string | undefined)[], flags);
    });
  }
}

/** The Examples/notes tail of a command's help. Plain text, terminal-independent (clig on formatting). */
function extraHelp(spec: CommandSpec): string {
  const lines: string[] = [];
  if (spec.examples && spec.examples.length > 0) {
    lines.push("", "Examples:");
    // Inline, column-aligned notes (`$ cmd   # note`) — a note on its own line reads as a stray
    // fragment when neighboring examples have none.
    const width = Math.max(...spec.examples.map((e) => e.cmd.length));
    for (const e of spec.examples) {
      lines.push(e.note ? `  $ ${e.cmd.padEnd(width)}   # ${e.note}` : `  $ ${e.cmd}`);
    }
  }
  if (spec.notes) lines.push("", spec.notes);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
