/**
 * The apt packages an environment declares, on THIS machine: the image installs them, and a machine that runs the agent
 * locally supplies its own. Only Debian and Ubuntu can be asked (dpkg); elsewhere nothing is said, and FastAgent never
 * runs apt itself.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** The packages of `names` this machine does not have, or undefined when it cannot tell (not Debian or Ubuntu). */
export function missingAptPackages(
  names: readonly string[],
  debian = existsSync("/etc/debian_version"),
): string[] | undefined {
  if (!debian) return undefined;
  if (names.length === 0) return [];
  // dpkg-query exits 1 when a name is unknown to it; the names it does know are still printed.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own format, not a template
  const result = spawnSync("dpkg-query", ["-W", "-f=${Package} ${db:Status-Status}\n", ...names], { encoding: "utf8" });
  if (result.error) throw new Error(`dpkg-query could not run: ${result.error.message}`);
  const installed = new Set(
    result.stdout
      .split("\n")
      .filter((line) => line.endsWith(" installed"))
      .map((line) => line.split(" ")[0]),
  );
  return names.filter((name) => !installed.has(name));
}

/** What to tell whoever runs the agent here, with the command that installs them. */
export function aptAdvice(missing: readonly string[]): string {
  return (
    `the image installs apt packages this machine does not have: ${missing.join(", ")} — ` +
    `\`sudo apt-get install -y ${missing.join(" ")}\``
  );
}
