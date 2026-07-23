/** stderr renders color: a color TTY, with Node's `hasColors()` carrying the NO_COLOR/TERM=dumb veto. */
function stderrHasColors(): boolean {
  return process.stderr.isTTY === true && (process.stderr.hasColors?.() ?? false);
}

/**
 * The ONE error prefix every error message carries — bold red when stderr renders color, plain
 * otherwise. Errors are the only place the CLI uses color at all.
 */
export function errorPrefix(colors: boolean = stderrHasColors()): string {
  return colors ? "\x1b[1;31mError:\x1b[0m" : "Error:";
}

/**
 * User-fixable startup problems (missing model / bad config / broken definition) are thrown as plain
 * `Error` — print just the message. Anything else (TypeError, non-Error) is a bug: keep the stack.
 * Shared by the kernel and the command modules; exit 1 (runtime failure).
 */
export function failStartup(error: unknown): never {
  if (error instanceof Error && error.constructor === Error) console.error(`${errorPrefix()} ${error.message}`);
  else console.error(errorPrefix(), error);
  process.exit(1);
}

/**
 * A usage error the parser could not catch (a bad value shape, an invalid flag/argument combination
 * discovered in a command body): print the message and exit 2 — the same class as a parse error.
 * Exit codes follow responsibility, not the layer that happens to discover the problem.
 */
export function failUsage(message: string): never {
  console.error(`${errorPrefix()} ${message}`);
  process.exit(2);
}
