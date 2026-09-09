import { type ResolvedPlacement, resolvePlacement } from "../paths.ts";
import { gateSecrets } from "../secrets-gate.ts";

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

/**
 * {@link gateSecrets} at the process boundary, for a command that runs ONE owner's code (`fastagent
 * tool`, `fastagent fire`). The gate throws SYNCHRONOUSLY, so there is no promise to hang the usual
 * `.catch(failStartup)` on, and a raw throw reaches `cli.ts`'s top-level await as a Node stack that
 * buries the one line naming the file. The catch translates that expected failure into the CLI's
 * single-line refusal and exits 1; nothing is recovered.
 */
export function gateSecretsOrExit(input: Parameters<typeof gateSecrets>[0]): void {
  try {
    gateSecrets(input);
  } catch (error) {
    failStartup(error);
  }
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
