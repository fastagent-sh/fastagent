import { type ResolvedPlacement, resolvePlacement } from "../paths.ts";

/** stderr renders color: a color TTY, with Node's `hasColors()` carrying the NO_COLOR/TERM=dumb veto. */
function stderrHasColors(): boolean {
  return process.stderr.isTTY === true && (process.stderr.hasColors?.() ?? false);
}

/** The ONE error prefix every error message carries — bold red when stderr renders color, plain otherwise. */
export function errorPrefix(colors: boolean = stderrHasColors()): string {
  return colors ? "\x1b[1;31mError:\x1b[0m" : "Error:";
}

/**
 * User-fixable startup problems (missing model / bad config / broken definition) are thrown as plain `Error` — print
 * just the message. Anything else (a TypeError, a non-Error throw) is a bug: keep the stack.
 */
export function failStartup(error: unknown): never {
  if (error instanceof Error && error.constructor === Error) console.error(`${errorPrefix()} ${error.message}`);
  else console.error(errorPrefix(), error);
  process.exit(1);
}

/** THE placement entry point for commands: resolve `dir`, or exit 1 with the one-line refusal. */
export function placementOrExit(dir: string): ResolvedPlacement {
  try {
    return resolvePlacement(dir);
  } catch (error) {
    failStartup(error);
  }
}

/**
 * A usage error the parser could not catch (a bad value shape, an invalid flag/argument combination discovered in a
 * command body): print the message and exit 2.
 */
export function failUsage(message: string): never {
  console.error(`${errorPrefix()} ${message}`);
  process.exit(2);
}
