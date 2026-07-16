/**
 * User-fixable startup problems (missing model / bad config / broken definition) are thrown as plain
 * `Error` — print just the message. Anything else (TypeError, non-Error) is a bug: keep the stack.
 * Shared by the cli.ts dispatch and the kernel command modules.
 */
export function failStartup(error: unknown): never {
  if (error instanceof Error && error.constructor === Error) console.error(error.message);
  else console.error(error);
  process.exit(1);
}

/**
 * A usage error the parser could not catch (a bad value shape, an invalid flag/argument combination
 * discovered in a command body): print the message and exit 2 — the same class as a parse error.
 * Exit codes follow responsibility, not the layer that happens to discover the problem.
 */
export function failUsage(message: string): never {
  console.error(message);
  process.exit(2);
}
