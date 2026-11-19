/**
 * Global `-C <dir>` prefix option (as in `git -C` and `make -C`): changes the working directory before project CLI
 * forwarding, extension lookup, or subcommand parsing, and strips the consumed `-C` tokens from `argv` so a forwarded
 * project CLI or `dev` worker never applies a relative `-C` a second time.
 */
import { failUsage } from "./fail.ts";

/** Extract leading `-C <dir>` / `-C<dir>` / `-C=<dir>` options that appear before the subcommand. */
function extractChdir(argv: readonly string[]): { dirs: string[]; argv: string[] } {
  const dirs: string[] = [];
  const head = argv.slice(0, 2);
  let i = 2;
  while (i < argv.length) {
    const token = argv[i] as string;
    if (token === "-C") {
      const next = argv[i + 1];
      if (next === undefined || next.trim() === "") failUsage("option '-C <dir>' argument missing");
      dirs.push(next);
      i += 2;
      continue;
    }
    if (token.startsWith("-C=")) {
      const value = token.slice(3);
      if (value.trim() === "") failUsage("option '-C <dir>' argument missing");
      dirs.push(value);
      i += 1;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      const value = token.slice(2);
      if (value.trim() === "") failUsage("option '-C <dir>' argument missing");
      dirs.push(value);
      i += 1;
      continue;
    }
    break;
  }
  return { dirs, argv: [...head, ...argv.slice(i)] };
}

/** Apply any leading `-C <dir>` options to `process.cwd()` and return `argv` without them. */
export function applyChdir(argv: readonly string[]): string[] {
  const { dirs, argv: stripped } = extractChdir(argv);
  for (const dir of dirs) {
    try {
      process.chdir(dir);
    } catch (error) {
      failUsage(`-C ${dir}: ${(error as Error).message}`);
    }
  }
  return stripped;
}
