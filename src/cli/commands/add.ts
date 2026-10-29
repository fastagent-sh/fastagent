/**
 * `fastagent add <channel>|skill` — scaffold channel glue (`src/channels/<kind>.ts`) or vendor an Agent Skills skill.
 * slack/feishu/lark additionally CREATE OR RESUME the platform app.
 */
import { randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { assertIndependentFeishuApps, onboardFeishuCloudApp } from "../add-feishu.ts";
import { cloudFor } from "../../channels/feishu/cloud.ts";
import { type FeishuSubscriptionMode, feishuIngressFor } from "../../channels/feishu/setup-mode.ts";
import { markDevServe, unmarkDevServe } from "../../serving-command.ts";
import { channelIngress } from "../../channels/discover.ts";
import { buildDefinitionShape, prepareDefinition } from "../../harnesses/pi-durable/open.ts";
import { dotEnvPath, enterAgentEnv, loadEnvValues } from "../../env.ts";
import { selectAgentEnvironment, resolveStateRoot, SECRETS_DIRNAME, isUnderDir, displayPath } from "../../paths.ts";
import { detectRuntime, readPackageJson } from "../../runtime.ts";
import {
  type ChannelKind,
  appendChannelDotEnv,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
  scaffoldCompanionTools,
} from "../../scaffold/add-channel.ts";
import { vendorSkill } from "../../scaffold/vendor-skill.ts";
import { failStartup, failUsage, agentDirOrExit } from "../fail.ts";
import { isInteractive } from "../shared.ts";
import { unprotectedSecretsNote } from "../../value-file.ts";

/** `fastagent add <kind> [dir]`: scaffold `src/channels/<kind>.ts`, the adapter configured with a starter policy. */
export async function runAddChannel(
  channelKind: ChannelKind,
  dirArg: string,
  opts: { ingress?: string; onboard?: boolean; replaceConfig?: boolean; environment?: string; input?: boolean },
): Promise<void> {
  // The channel (glue + companion tools + secrets) is agent surface: everything lands in the AGENT DIR.
  if (opts.replaceConfig && opts.onboard === false) {
    failUsage("--replace-config replaces onboarding credentials; it cannot be combined with --no-onboard");
  }
  const target = agentDirOrExit(resolve(dirArg));
  const interactive = opts.input !== false && isInteractive();
  // Refused before anything is written: Slack's app is created and installed through questions in a terminal.
  if (channelKind === "slack" && opts.onboard !== false && !interactive) {
    failUsage(
      "`add slack` creates and installs the Slack app by asking in a terminal — run it in one, or pass --no-onboard " +
        "to scaffold only and set the app up yourself",
    );
  }
  const environment = opts.environment ?? "dev";
  if (environment !== "dev" && environment !== "production") {
    failUsage(`--env must be "dev" or "production", got "${environment}"`);
  }
  selectAgentEnvironment(environment);
  if (environment === "production") unmarkDevServe();
  else markDevServe();
  enterAgentEnv(target);
  if (environment === "production" && (channelKind === "feishu" || channelKind === "lark")) {
    try {
      assertIndependentFeishuApps(target, [channelKind], loadEnvValues(dotEnvPath(target)));
    } catch (error) {
      failStartup(error);
    }
  }
  // Paths are printed to someone standing in their CWD, which may be elsewhere, while every file belongs to the AGENT
  // dir — prefix them, or they point at nothing.
  const agentFromCwd = displayPath(process.cwd(), target);
  const inAgent = (p: string): string => (agentFromCwd === undefined ? p : join(agentFromCwd, p));
  const envPath = dotEnvPath(target);
  const envLabel = isUnderDir(envPath, target) ? inAgent(relative(target, envPath)) : envPath;
  // An existing channel file is authored glue: kept, never rewritten.
  const file = join(target, "src", "channels", `${channelKind}.ts`);
  const existsAlready = await channelExists(target, channelKind).catch(failStartup);
  const { ingress, pinned, setting } = resolveIngress(channelKind, opts.ingress);
  if (
    existsAlready &&
    (setting || (environment === "production" && opts.onboard !== false)) &&
    (channelKind === "feishu" || channelKind === "lark")
  ) {
    await assertChannelReadsSetting(
      target,
      channelKind,
      setting ?? { [`${cloudFor(channelKind).envPrefix}_INGRESS`]: ingress },
      inAgent(relative(target, file)),
    );
  }
  if (existsAlready) {
    console.error(`[fastagent] ${inAgent(relative(target, file))} already exists — keeping it`);
  } else {
    await assertChannelReady(target).catch(failStartup);
    await scaffoldChannel(target, channelKind).catch(failStartup);
    console.error(`[fastagent] created ${inAgent(relative(target, file))}`);
  }
  // Companion tools are the package's, not authored glue.
  for (const tool of await scaffoldCompanionTools(target, channelKind).catch(failStartup)) {
    console.error(`[fastagent] wrote ${inAgent(relative(target, tool))}`);
  }
  if (await appendChannelEnv(target, channelKind).catch(failStartup)) {
    console.error(`[fastagent] added ${channelKind} env vars to ${inAgent(join(SECRETS_DIRNAME, ".env.example"))}`);
  }
  // Stateful app onboarding is re-runnable after the scaffold boundary.
  let created: Record<string, string> | undefined;
  if (channelKind === "slack" && opts.onboard !== false) {
    const { onboardSlackInternalApp } = await import("../add-slack.ts");
    created = await onboardSlackInternalApp({
      target,
      stateRoot: resolveStateRoot(target),
      replaceConfig: opts.replaceConfig,
    })
      .then(() => undefined)
      .catch(failStartup);
  } else if ((channelKind === "feishu" || channelKind === "lark") && opts.onboard !== false) {
    const rerun = `fastagent add ${channelKind}${environment === "production" ? " --env production" : ""}${opts.ingress ? ` --ingress ${opts.ingress}` : ""}`;
    created = await onboardFeishuCloudApp(target, channelKind, ingress, rerun, interactive).catch(failStartup);
  }
  const setup = channelSetup(channelKind, ingress, pinned);
  const env = setup.env;
  const steps =
    channelKind === "slack" && opts.onboard !== false
      ? [
          // No line about the Request URL: the `dev --tunnel` line below is the whole instruction, and FastAgent sets
          // that URL itself when the agent first runs.
          "invite the app to each channel it should read",
          // The tool lines are the scaffold's (one list), whichever path set the app up.
          ...setup.steps.filter((step) => step.includes("{tools}/")),
        ]
      : setup.steps;
  const generated = Object.fromEntries(
    env.filter((e) => e.generate).map((e) => [e.name, randomBytes(24).toString("hex")]),
  );
  // Kind-neutral: every channel's generated secrets get the same treatment.
  const dotEnv = await appendChannelDotEnv(
    target,
    channelKind,
    { ...generated, ...created, ...setting },
    [...Object.keys(created ?? {}), ...Object.keys(setting ?? {})],
    ingress,
  ).catch(failStartup);
  if (dotEnv.unprotectedSecretsDir) {
    console.error(`[fastagent] note: ${unprotectedSecretsNote(dotEnv.unprotectedSecretsDir)}`);
  }
  if (dotEnv.written.length > 0) {
    console.error(`[fastagent] wrote ${dotEnv.written.join(", ")} to ${envLabel}`);
  }
  const install =
    detectRuntime(target, await readPackageJson(target).catch(failStartup)).runtime === "bun"
      ? "bun install"
      : "npm install";
  console.error(`  next steps:`);
  console.error(
    `    ${agentFromCwd === undefined ? install : `(cd ${agentFromCwd} && ${install})`}                      # if @fastagent-sh/fastagent is not installed yet`,
  );
  for (const e of env) {
    if (dotEnv.alreadySet.includes(e.name)) continue; // the user already has it — nothing to do
    if (dotEnv.written.includes(e.name)) {
      // Written, but its hint may still carry an action — keep the variable visible instead of silently absorbing it.
      console.error(`    ${e.name} — ${e.generate ? "generated and " : ""}written to ${envLabel}   # ${e.hint}`);
      continue;
    }
    const value = e.generate ? `=${generated[e.name]}` : "";
    const action = e.required ? "set" : "optionally set";
    console.error(`    ${action} ${e.name}${value} in ${envLabel}   # ${e.hint}`);
  }
  const serveCommand = environment === "production" ? "fastagent start" : "fastagent dev";
  for (const s of steps) {
    console.error(
      `    ${s
        .replace("{channel}", inAgent(relative(target, file)))
        .replace("{tools}", inAgent(join("src", "tools")))
        .replaceAll("{serve}", serveCommand)}`,
    );
  }
  if (environment === "production") {
    console.error(`    fastagent deploy <host> --run   # deploy with the production app and credentials`);
  } else if (ingress === "websocket") {
    console.error(`    fastagent dev            # no public URL or tunnel required`);
  } else if (channelKind === "slack") {
    console.error(
      `    fastagent dev --tunnel   # ${opts.onboard === false ? "serve locally + print the URL to paste into the Slack app's Event Subscriptions" : "start the agent — then message it in Slack"}`,
    );
  } else if (channelKind !== "lark") {
    console.error(`    fastagent dev --tunnel   # serve locally + a public URL, auto-registering the webhook`);
  }
  // App-creation flows leave platform/tunnel sockets behind that would otherwise hold the one-shot scaffold command
  // open after all durable boundaries have completed.
  process.exit(0);
}

/**
 * What `add` sets the app up for, and whether it writes the choice down. `--ingress` is the `<PREFIX>_INGRESS`
 * setting in the selected environment. The channel rule supplies its default: WebSocket in dev, webhook in production.
 */
function resolveIngress(
  kind: ChannelKind,
  raw: string | undefined,
): { ingress: FeishuSubscriptionMode; pinned: boolean; setting?: Record<string, string> } {
  if (raw !== undefined && raw !== "webhook" && raw !== "websocket") {
    failUsage(`--ingress must be "webhook" or "websocket", got "${raw}"`);
  }
  if (kind !== "feishu" && kind !== "lark") return { ingress: "webhook", pinned: false };
  const name = `${cloudFor(kind).envPrefix}_INGRESS`;
  if (raw !== undefined) return { ingress: raw, pinned: true, setting: { [name]: raw } };
  try {
    return {
      ingress: feishuIngressFor(kind, process.env),
      pinned: Boolean(process.env[name]?.trim()),
    };
  } catch (error) {
    // A malformed value in the environment: the author's to fix, said as the rule says it.
    return failUsage((error as Error).message);
  }
}

/**
 * A setting only takes effect in a channel file that reads it: one that names its factory receives the same way
 * whatever the setting says, so writing the setting (and configuring the app for it) would change nothing but the app.
 * Asked of the channel as the agent builds it, under the value this command is about to write.
 */
async function assertChannelReadsSetting(
  target: string,
  kind: ChannelKind,
  setting: Record<string, string>,
  shown: string,
): Promise<void> {
  Object.assign(process.env, setting); // the value this command writes anyway
  const channel = await prepareDefinition(target)
    .then((definition) => buildDefinitionShape(definition, process.env).channels.get(kind))
    .catch((error: unknown) =>
      failStartup(new Error(`the agent does not build (${(error as Error).message}) — fix it and re-run`)),
    );
  const [[name, value]] = Object.entries(setting) as [[string, string]];
  const wanted = value === "webhook" ? "webhook" : "long-connection";
  const shape = channel === undefined ? undefined : channelIngress(channel);
  if (shape !== wanted) {
    failStartup(
      new Error(
        `${shown} receives by ${shape === "webhook" ? "webhook" : "WebSocket"} whatever ${name} says — it names ` +
          `its factory instead of reading the setting, so ${name}=${value} would change nothing but the app. Move ` +
          `the file aside and re-run to scaffold one that reads it, or edit its factory yourself`,
      ),
    );
  }
}

/** `fastagent add skill <source> [dir]`: vendor an Agent Skills skill into <dir>/skills/<name>/. */
export async function runAddSkill(
  source: string | undefined,
  dirArg: string,
  opts: { update?: boolean },
): Promise<void> {
  const target = agentDirOrExit(resolve(dirArg));
  if (!source) {
    // A missing source is a usage error (exit 2), but the guide is worth more than a bare missing-argument line.
    failUsage(
      `add a skill — two ways:\n` +
        `  1. write your own (vibe): create skills/<name>/SKILL.md with name + description\n` +
        `     frontmatter; it's auto-discovered. No command needed — this is the common path.\n` +
        `  2. vendor an existing Agent Skills skill (copied in, git-tracked):\n` +
        `       fastagent add skill <source> [dir]\n` +
        `     source: a git ref (owner/repo/path, github default), a local path (./x, /abs), or a\n` +
        `             bare name found in your global skill dirs (~/.agents/skills, ~/.pi/agent/skills)\n` +
        `     --update overwrites an existing skill (re-fetch from source); review with git diff`,
    );
  }
  // Skills are agent surface — vendored into the agent dir's `skills/`.
  enterAgentEnv(target); // a git-ref source is a network fetch (giget uses global fetch)
  const { name, description, dest, hasScripts, overwritten } = await vendorSkill(target, source, {
    update: opts.update ?? false,
  }).catch(failStartup);
  console.error(`[fastagent] ${overwritten ? "updated" : "vendored"} skill "${name}" → ${dest}/`);
  if (overwritten) console.error(`  overwrote it — \`git diff ${dest}\` to review, \`git checkout ${dest}\` to revert`);
  if (description) console.error(`  ${description.length > 100 ? `${description.slice(0, 100)}…` : description}`);
  if (hasScripts) {
    console.error(
      `  warn: this skill ships scripts/ (executable code that runs in your agent) — review it before deploying`,
    );
  }
  console.error(`  next: mention "${name}" in SYSTEM.md so the model knows when to use it; then \`fastagent dev\``);
}
