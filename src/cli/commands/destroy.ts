/** `fastagent destroy agentcore [dir]`: remove every AWS resource the deploy created. */
import { basename, resolve } from "node:path";
import { destroyAgentcoreDeployment } from "../../deploy/agentcore/destroy.ts";
import { agentcoreName } from "../../deploy/agentcore/plan.ts";
import { spawnRunner } from "../../deploy/runner.ts";
import { enterAgentEnv } from "../../env.ts";
import { failStartup, failUsage, placementOrExit } from "../fail.ts";

export interface DestroyOptions {
  run?: boolean;
}

export async function runDestroy(host: string, dirArg: string, opts: DestroyOptions): Promise<void> {
  // The host argument is DISPATCHED here, as in runLogs. In practice commander rejects anything else first
  // (the spec declares `choices`), so what the operator reads is its message plus the spec's notes, which name
  // the other hosts' own commands. This stays as the seam: a host added to `choices` must not be silently
  // treated as agentcore.
  if (host !== "agentcore") failUsage(`destroy: unsupported host "${host}"`);
  const placement = placementOrExit(resolve(dirArg));
  enterAgentEnv(placement.agentDir); // AWS_PROFILE/region/proxy may be definition-local, as on deploy
  const name = agentcoreName(basename(placement.workspace));
  const outcome = await destroyAgentcoreDeployment(
    { name, run: opts.run === true },
    spawnRunner("aws", placement.workspace),
    (message) => console.error(`[fastagent] destroy: ${message}`),
  );
  if (!outcome.ok) {
    // THE WHOLE PICTURE, before the gate: a half-finished teardown is exactly when an operator needs to know
    // what is out there, what is already gone, and what the retry still has to reach.
    if (outcome.found.length > 0) {
      console.log(`what a deploy of "${name}" put in this account:`);
      for (const item of outcome.found) console.log(`  ${item}`);
    }
    if (outcome.removed.length > 0) {
      console.log(`deleted before stopping:`);
      for (const item of outcome.removed) console.log(`  ${item}`);
    }
    // The kept bucket belongs in EVERY report: it is the one thing this command decided not to delete, and a
    // failure elsewhere is no reason for the operator to stop hearing about it.
    for (const item of outcome.kept) console.log(`\nKEPT: ${item}`);
    failStartup(new Error(`destroy stopped: ${outcome.gate}`));
  }

  if (!opts.run) {
    if (outcome.found.length === 0) {
      console.log(`nothing in this account for "${name}" — no stack, bucket, repository or log group.`);
      return;
    }
    console.log(`what a deploy of "${name}" put in this account:`);
    for (const item of outcome.found) console.log(`  ${item}`);
    for (const item of outcome.kept) console.log(`  NOT MINE TO DELETE: ${item}`);
    console.log(`\nnothing was deleted. Re-run with --run to delete all of it.`);
    return;
  }
  console.log(outcome.removed.length > 0 ? `deleted:` : `nothing left to delete for "${name}".`);
  for (const item of outcome.removed) console.log(`  ${item}`);
  for (const item of outcome.kept) console.log(`\nKEPT: ${item}`);
}
