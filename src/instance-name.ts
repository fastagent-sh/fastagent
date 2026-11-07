/**
 * An instance's name (agent-artifact.md §4.5): the one thing `info().name` and a host's report call it. An explicit name
 * is one path segment, since what a host creates for an instance is named after it, and is refused otherwise; the
 * default is the definition's name made into one (`@scope/pkg` is not one), so two instances of one definition on one
 * machine take distinct names only by being given them.
 */
export const INSTANCE_NAME_ENV = "FASTAGENT_NAME";

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Whether `name` can name an instance: one path segment of letters, digits, `-` and `_`. */
function isInstanceName(name: string): boolean {
  return SEGMENT.test(name);
}

/** The instance's name: `given` when there is one (refused when it is not a segment), else the definition's, as one. */
export function instanceName(definitionName: string, given?: string): string {
  if (given !== undefined) {
    if (!isInstanceName(given)) {
      throw new Error(
        `the instance name ${JSON.stringify(given)} must be one path segment of letters, digits, "-" and "_"`,
      );
    }
    return given;
  }
  return definitionName.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}
