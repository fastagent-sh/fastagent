/** CLI kernel — commands as data. */
import { Argument, Command, Help, InvalidArgumentError, Option } from "commander";
import { errorPrefix } from "./fail.ts";

/** One positional argument, in commander syntax: `<name>` required, `[dir]` optional. */
interface ArgSpec {
  name: string;
  description: string;
  default?: string;
  /** Closed value set — the parser rejects anything else as a usage error (exit 2). */
  choices?: string[];
}

/** One flag, in the flag DSL: `--json`, or `--sessions-dir <dir>` for a value-taking flag. */
export interface FlagSpec {
  flags: string;
  description: string;
}

interface ExampleSpec {
  cmd: string;
  note?: string;
}

export interface CommandSpec {
  name: string;
  /** One line for the command list in the parent help. */
  summary: string;
  /** Longer description for the command's own help; defaults to `summary`. */
  description?: string;
  args?: ArgSpec[];
  flags?: FlagSpec[];
  /** Shown in an "Examples:" section of the command's help — clig: users reach for examples first. */
  examples?: ExampleSpec[];
  /** Narrative help (behavior, precedence rules, caveats) appended after the generated sections. */
  notes?: string;
  /** A group command (e.g. `schedule`) declares subcommands instead of `run`. */
  subcommands?: CommandSpec[];
  /**
   * The implementation: positional args in declaration order (an optional arg without a default is `undefined`), then
   * the parsed flags.
   */
  run?: (args: (string | undefined)[], flags: Record<string, unknown>) => Promise<void> | void;
}

export interface ProgramOptions {
  /** Printed by `-v`/`--version`. */
  version?: string;
  /** Top-level Examples — rendered by the same Help pipeline as every command's. */
  examples?: ExampleSpec[];
  /** Top-level closing prose (the docs link) — reflowed like any notes. */
  notes?: string;
  /** Fixed help width — a TEST seam. */
  helpWidth?: number;
  /** Force help colors on/off — a TEST seam. */
  colors?: boolean;
  out?: (chunk: string) => void;
  err?: (chunk: string) => void;
  exit?: (code: number) => never;
}

/**
 * The option key a flag string yields on the parsed-flags record — the naming rule specs rely on: camelCase of the
 * long name (`--sessions-dir` → `sessionsDir`); a `--no-x` flag negates and stores under `x` (absent ⇒ `x !== false`).
 */
export function optionKey(flags: string): string {
  const long = flags
    .split(/[\s,|]+/)
    .filter((part) => part.startsWith("--"))
    .at(-1);
  if (!long) throw new Error(`flag "${flags}" has no long form (clig: have full-length flags)`);
  let name = long.replace(/^--/, "").replace(/[=<[].*$/, "");
  if (name.startsWith("no-")) name = name.slice(3);
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Help styling (clig: formatting with intention): section headings are BOLD, nothing in help is colored — the only
// color in the whole CLI is the red error prefix.
const title = (s: string): string => `\x1b[1m${s}\x1b[0m`; // bold — section headings

/** The spec behind each registered command — how the Help renderer reaches Examples/notes. */
const specOf = new WeakMap<Command, CommandSpec>();

export function buildProgram(specs: readonly CommandSpec[], options: ProgramOptions = {}): Command {
  const exit: (code: number) => never = options.exit ?? ((code) => process.exit(code));
  const program = new Command("fastagent");
  program.description("Serve a file-defined agent — persona.md, skills/, tools/, channels/ — as a live service.");
  // The exit-code policy: commander throws only for parse-level events — help/version displays carry exitCode 0 (→
  // 0), everything else it rejects is a usage error (→ 2).
  program.exitOverride((err) => exit(err.exitCode === 0 ? 0 : 2));
  program.configureHelp({
    ...(options.helpWidth !== undefined ? { helpWidth: options.helpWidth } : {}),
    styleTitle: title,
    // ONE renderer for the whole page: commander's standard sections, then our Examples/notes.
    formatHelp: (cmd, helper) => Help.prototype.formatHelp.call(helper, cmd, helper) + extraSections(cmd, helper),
  });
  program.configureOutput({
    ...(options.out ? { writeOut: options.out } : {}),
    ...(options.err ? { writeErr: options.err } : {}),
    ...(options.colors !== undefined
      ? { getOutHasColors: () => options.colors as boolean, getErrHasColors: () => options.colors as boolean }
      : {}),
    // Every parse-level error carries the ONE unified prefix: bold-red `Error:` (plain when stderr has no colors).
    outputError: (str, write) =>
      write(str.startsWith("error:") ? `${errorPrefix(options.colors)}${str.slice("error:".length)}` : str),
  });
  program.showSuggestionAfterError(); // "did you mean models?" — suggest only, never run it (clig on DWIM)
  program.showHelpAfterError("(run with --help for usage)");
  if (options.version) program.version(options.version, "-v, --version", "print the fastagent version");
  if (options.examples || options.notes) {
    specOf.set(program, { name: "fastagent", summary: "", examples: options.examples, notes: options.notes });
  }
  // Subcommands inherit exitOverride/output/suggestion settings at .command() time — register last.
  for (const spec of specs) register(program, spec);
  return program;
}

function register(parent: Command, spec: CommandSpec): void {
  const cmd = parent.command(spec.name);
  specOf.set(cmd, spec);
  cmd.summary(spec.summary);
  cmd.description(spec.description ?? spec.summary);
  for (const a of spec.args ?? []) {
    const arg = new Argument(a.name, a.description);
    if (a.default !== undefined) arg.default(a.default);
    if (a.choices) arg.choices(a.choices);
    // A required argument means a non-empty VALUE, not just a present token.
    if (a.name.startsWith("<") && !a.choices) {
      arg.argParser((value: string) => {
        if (value.trim() === "") throw new InvalidArgumentError("must not be empty.");
        return value;
      });
    }
    cmd.addArgument(arg);
  }
  for (const f of spec.flags ?? []) cmd.addOption(new Option(f.flags, f.description));
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

/** The Examples/notes sections a spec appends after commander's standard ones. */
function extraSections(cmd: Command, helper: Help): string {
  const spec = specOf.get(cmd);
  if (!spec || ((spec.examples?.length ?? 0) === 0 && !spec.notes)) return "";
  const width = helper.helpWidth ?? 80;
  const lines: string[] = [];
  if (spec.examples && spec.examples.length > 0) {
    lines.push(helper.styleTitle("Examples:"));
    // Inline, column-aligned notes (`$ cmd # note`) — a note on its own line reads as a stray fragment when
    // neighboring examples have none.
    const w = Math.max(...spec.examples.map((e) => e.cmd.length));
    for (const e of spec.examples) {
      lines.push(e.note ? `  $ ${e.cmd.padEnd(w)}   # ${e.note}` : `  $ ${e.cmd}`);
    }
    lines.push("");
  }
  if (spec.notes) {
    lines.push(...reflow(spec.notes, width, helper));
    lines.push("");
  }
  return `\n${lines.join("\n")}`;
}

/** Reflow notes to the help width: plain lines are prose (joined and wrapped via the helper's own `boxWrap`). */
function reflow(text: string, width: number, helper: Help): string[] {
  const out: string[] = [];
  let prose: string[] = [];
  const flush = (): void => {
    if (prose.length > 0) {
      out.push(...helper.boxWrap(prose.join(" "), width).split("\n"));
      prose = [];
    }
  };
  for (const line of text.split("\n")) {
    if (/^\s/.test(line)) {
      flush();
      out.push(line);
    } else if (line === "") {
      flush();
      out.push("");
    } else {
      prose.push(line);
    }
  }
  flush();
  return out;
}
