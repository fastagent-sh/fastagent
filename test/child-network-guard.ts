/**
 * The network guard in a child process a test starts: `test/setup.ts` puts this file in NODE_OPTIONS (`--import`), so
 * every Node process a test spawns, the CLI included, refuses a connection off the machine as the test's own process
 * does, and writes what it refused where the test reads it after it (forbidden.ts). A process that is not Node (git, a
 * stand-in shell script) is not covered.
 */
import { appendFileSync } from "node:fs";
import { CHILD_REFUSALS, refuseConnectionsOffTheMachine } from "./network-guard.ts";

const file = process.env[CHILD_REFUSALS];
refuseConnectionsOffTheMachine((what) => {
  if (file !== undefined)
    appendFileSync(file, `${what} (pid ${process.pid}: ${process.argv.slice(1).join(" ").slice(0, 200)})\0`);
  return new Error(what);
});
