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
