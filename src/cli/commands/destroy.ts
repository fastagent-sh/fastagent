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
  // The host argument is DISPATCHED here, as in runDeploy. Only AgentCore needs this command: fly and railway
  // have `fly apps destroy` / `railway down`, and docker has `docker compose down -v`.
  if (host !== "agentcore") {
    failUsage(
      `destroy: unsupported host "${host}" — only agentcore needs it (fly: \`fly apps destroy\`, ` +
        `railway: \`railway down\`, docker: \`docker compose -f fastagent.compose.yml down -v\`)`,
    );
  }
  const placement = placementOrExit(resolve(dirArg));
  enterAgentEnv(placement.agentDir); // AWS_PROFILE/region/proxy may be definition-local, as on deploy
  const name = agentcoreName(basename(placement.workspace));
  const outcome = await destroyAgentcoreDeployment(
    { name, run: opts.run === true },
    spawnRunner("aws", placement.workspace),
    (message) => console.error(`[fastagent] destroy: ${message}`),
  );
  if (!outcome.ok) {
    // WHAT IT MANAGED TO DELETE, before the gate: a half-finished teardown is exactly when an operator needs
    // to know which resources are already gone and which the retry still has to reach.
    if (outcome.removed.length > 0) {
      console.log(`deleted before stopping:`);
      for (const item of outcome.removed) console.log(`  ${item}`);
    }
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
