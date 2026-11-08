/**
 * An instance's name (agent-artifact.md §4.5): the one thing `info().name` and a host's report call it. An explicit name
 * is one path segment, since what a host creates for an instance is named after it, and is refused otherwise; the
 * default is the definition's name made into one (`@scope/pkg` is not one), so two instances of one definition on one
 * machine take distinct names only by being given them.
 */
export const INSTANCE_NAME_ENV = "FASTAGENT_NAME";

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** `name`, when it can name an instance: one path segment of letters, digits, `-` and `_`; refused otherwise. */
export function checkInstanceName(name: string): string {
  if (!SEGMENT.test(name)) {
    throw new Error(
      `the instance name ${JSON.stringify(name)} must be one path segment of letters, digits, "-" and "_"`,
    );
  }
  return name;
}

/** The name `FASTAGENT_NAME` gives: unset and empty are the same, as for the path variables. */
export function enteredInstanceName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[INSTANCE_NAME_ENV] || undefined;
}

/** The instance's name: `given` when there is one (refused when it is not a segment), else the definition's, as one. */
export function instanceName(definitionName: string, given?: string): string {
  if (given !== undefined) return checkInstanceName(given);
  return trimmed(definitionName.replace(/[^A-Za-z0-9_-]/g, "-")) || "agent";
}

/** `text` without the `-` at either end: by index, since a regex for it backtracks quadratically on a long run. */
function trimmed(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "-") start++;
  while (end > start && text[end - 1] === "-") end--;
  return text.slice(start, end);
}
