/**
 * `fastagent channels setup <platform>`: set up one channel's platform app for one instance: ask a
 * person for the values only they have, check them with the platform, and keep them in the instance's value file.
 */
import { resolve } from "node:path";
import { type SetupKind, isSetupKind, setUpChannel } from "../channel-setup.ts";
import { enterAgentEnv } from "../../env.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { markDevServe, unmarkDevServe } from "../../serving-command.ts";
import { dotEnvPath } from "../../value-file.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { enterEnvFile } from "../instance.ts";
import { shellArg } from "../../shell-arg.ts";
import { isInteractive, printReport } from "../shared.ts";

export interface ChannelsSetupOptions {
  /** The value file the credentials are kept in (created when missing): a deployment's, not the development one. */
  envFile?: string;
  json: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runChannelsSetup(name: string, dirArg: string, opts: ChannelsSetupOptions): Promise<void> {
  if (!isSetupKind(name)) {
    failUsage(`${name}: \`channels setup\` sets up telegram, slack, feishu and lark`);
  }
  const plan = planSetup(name, dirArg, opts);
  const interactive = opts.input !== false && !opts.json && isInteractive();
  const outcome = await setUpChannel({
    kind: plan.kind,
    agentDir: plan.agentDir,
    file: plan.file,
    dev: plan.dev,
    rerun: plan.rerun,
    interactive,
  }).catch(failStartup);

  if (outcome.status === "need_user_action") {
    const names = outcome.steps.flatMap((step) => step.fields.map((field) => field.name));
    const json = {
      status: "need_user_action",
      channel: plan.kind,
      file: outcome.file,
      steps: outcome.steps,
      rerun: `${plan.rerun} --json`,
      terminal_command: plan.rerun,
      agent_next_steps:
        `Do not ask the user to paste secrets into the conversation. Ask them to add ${names.join(", ")} to ` +
        `${outcome.file} (or run \`${plan.rerun}\` in their terminal), then re-run \`${plan.rerun} --json\`.`,
    };
    const text = [
      `need_user_action: ${plan.kind} credentials missing or invalid in ${outcome.file}`,
      ...outcome.steps.flatMap((step) => [
        `  ${step.label}: ${step.instructions}`,
        ...(step.url === undefined ? [] : [`    url: ${step.url}`]),
        ...(step.error === undefined ? [] : [`    error: ${step.error}`]),
        `    fields: ${step.fields.map((f) => f.name).join(", ")}`,
      ]),
      `  in a terminal: ${plan.rerun}`,
    ];
    printReport(opts.json, json, text);
    process.exit(2);
  }

  const serve = plan.dev ? "fastagent dev" : `fastagent start --env-file ${shellArg(plan.file)}`;
  const nextSteps = [serve, ...outcome.after];
  if (opts.json) {
    printReport(
      true,
      {
        status: "done",
        channel: plan.kind,
        file: plan.file,
        written: outcome.written,
        kept: outcome.kept,
        next_steps: nextSteps,
      },
      [],
    );
  } else {
    console.error("  next steps:");
    for (const line of nextSteps) console.error(`    ${line}`);
  }
  // Platform sockets left open would hold a one-shot command open after everything durable is done.
  process.exit(0);
}

/** What a setup settles before it asks anything. */
interface SetupPlan {
  kind: SetupKind;
  agentDir: string;
  /** Whether this is the development instance: no value file named. */
  dev: boolean;
  file: string;
  /** The command that runs it again. */
  rerun: string;
}

function planSetup(kind: SetupKind, dirArg: string, opts: ChannelsSetupOptions): SetupPlan {
  const agentDir = agentDirOrExit(resolve(dirArg));
  // The development instance is the default one; naming a value file is naming another.
  const dev = opts.envFile === undefined;
  selectAgentEnvironment(dev ? "dev" : "production");
  if (dev) markDevServe();
  else unmarkDevServe();
  enterEnvFile(opts.envFile, { defaultFile: dev, mayCreate: true });
  enterAgentEnv(agentDir);
  return {
    kind,
    agentDir,
    dev,
    file: dotEnvPath(agentDir),
    rerun:
      `fastagent channels setup ${kind} ${shellArg(agentDir)}` +
      `${opts.envFile === undefined ? "" : ` --env-file ${shellArg(resolve(opts.envFile))}`}`,
  };
}
