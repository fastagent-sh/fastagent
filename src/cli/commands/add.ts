/**
 * `fastagent add <channel>|skill` — scaffold channel glue (`channels/<kind>.ts`) or vendor an Agent
 * Skills skill. feishu/lark additionally CREATE OR RESUME the platform app (cli-add-feishu.ts).
 */
import { randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { onboardFeishuCloudApp } from "../../cli-add-feishu.ts";
import { loadConfig, resolveAgentDir } from "../../engines/pi/config.ts";
import { detectRuntime, readPackageJson } from "../../runtime.ts";
import {
  type ChannelKind,
  appendChannelDotEnv,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
} from "../../scaffold/add-channel.ts";
import { vendorSkill } from "../../scaffold/vendor-skill.ts";
import { loadRootIgnore } from "../../workspace.ts";
import { failStartup, failUsage } from "../fail.ts";

/** `fastagent add <kind> [dir]`: scaffold `channels/<kind>.ts` — the adapter import plus a starter `on()`. */
export async function runAddChannel(
  channelKind: ChannelKind,
  dirArg: string,
  opts: { createApp?: boolean },
): Promise<void> {
  const target = resolve(dirArg);
  // App creation is not a flag — it is what `add feishu` IS (the scan-to-create flow is the default
  // and only path there). The retired --create-app spelling gets a pointer, not silence.
  if (opts.createApp) {
    if (channelKind === "feishu") {
      console.error(`[fastagent] note: --create-app is retired — \`add feishu\` creates the app by default`);
    } else if (channelKind === "lark") {
      failStartup(
        new Error(
          "--create-app is retired — `add lark` now opens the developer console and guides credential setup by default",
        ),
      );
    } else {
      failStartup(new Error("--create-app is retired — app creation is the default behavior of `add feishu`"));
    }
  }
  // The channel (glue + companion tool) is agent surface — it lands in agentDir (config.agentDir, or
  // target when flat), the same place dev/start discover channels/. .env(.example) and the secret
  // hygiene stay at the run root, where .env is actually read.
  const { config: addConfig } = await loadConfig(target).catch(failStartup);
  const channelHome = resolveAgentDir(target, addConfig);
  // Preconditions before the write, so a refusal is side-effect-free. feishu/lark are exceptions:
  // their add is scaffold + ONBOARD THE APP, so an existing scaffold skips the write and continues (a
  // failed or cancelled scan/paste flow must be re-runnable without hand-deleting glue); never touch it.
  const file = join(channelHome, "channels", `${channelKind}.ts`);
  if (await channelExists(channelHome, channelKind).catch(failStartup)) {
    if (channelKind !== "feishu" && channelKind !== "lark") {
      failStartup(new Error(`${relative(target, file)} already exists — edit it, or remove it to re-scaffold`));
    }
    console.error(`[fastagent] ${relative(target, file)} already exists — keeping it`);
  } else {
    await assertChannelReady(channelHome).catch(failStartup);
    await scaffoldChannel(channelHome, channelKind).catch(failStartup);
    console.error(`[fastagent] created ${relative(target, file)}`);
  }
  if (await appendChannelEnv(target, channelKind).catch(failStartup)) {
    console.error(`[fastagent] added ${channelKind} env vars to .env.example`);
  }
  // Secret hygiene: a channel's GENERATED secret (a random string the user contributes nothing to) is
  // written into `.env` — but only when `.env` is already gitignored: the CLI must never materialize a
  // secret into a committable file. Warn, not refuse, when it is exposed — channel glue may read a real
  // env var instead.
  const envIgnored = (await loadRootIgnore(target).catch(failStartup))?.ignores(".env") ?? false;
  if (!envIgnored) {
    console.error(
      `[fastagent] warn: .env is not gitignored — a deploy that copies the directory would ship a secret placed there; add .env to .gitignore/.fastagentignore, or use a real env var`,
    );
  }
  // `add feishu`/`add lark` = scaffold + CREATE OR RESUME the app (cli-add-feishu.ts): feishu persists
  // its irreversible App ID/Secret boundary internally; lark returns guided credentials for the
  // generic .env write below.
  let created: Record<string, string> | undefined;
  if (channelKind === "feishu" || channelKind === "lark") {
    created = await onboardFeishuCloudApp(target, channelKind, envIgnored).catch(failStartup);
  }
  const { env, steps } = channelSetup(channelKind);
  const generated = Object.fromEntries(
    env.filter((e) => e.generate).map((e) => [e.name, randomBytes(24).toString("hex")]),
  );
  // Kind-neutral: every channel's generated secrets get the same treatment (github's webhook secret is
  // the same class of value as telegram's); guided Lark credentials ride the same write as overwrites.
  // Feishu's irreversible credentials were already staged inside cli-add-feishu.ts before bootstrap.
  const dotEnv = envIgnored
    ? await appendChannelDotEnv(target, channelKind, { ...generated, ...created }, Object.keys(created ?? {})).catch(
        failStartup,
      )
    : undefined;
  if (dotEnv && dotEnv.written.length > 0) {
    console.error(`[fastagent] wrote ${dotEnv.written.join(", ")} to .env`);
  }
  const install =
    detectRuntime(channelHome, await readPackageJson(channelHome)).runtime === "bun" ? "bun install" : "npm install";
  // The kit's manifest lives in channelHome (agentDir when set) — point the install there, not the run root.
  const installCmd = channelHome === target ? install : `(cd ${relative(target, channelHome)} && ${install})`;
  console.error(`  next steps:`);
  console.error(`    ${installCmd}                      # if @fastagent-sh/fastagent is not installed yet`);
  for (const e of env) {
    if (dotEnv?.alreadySet.includes(e.name)) continue; // the user already has it — nothing to do
    if (dotEnv?.written.includes(e.name)) {
      // Written, but its hint may still carry an action (github: paste the same value into the webhook
      // UI) — keep the variable visible instead of silently absorbing it.
      console.error(`    ${e.name} — ${e.generate ? "generated and " : ""}written to .env   # ${e.hint}`);
      continue;
    }
    const value = e.generate ? `=${generated[e.name]}` : "";
    const action = e.required ? "set" : "optionally set";
    console.error(`    ${action} ${e.name}${value} in .env${envIgnored ? " (gitignored)" : ""}   # ${e.hint}`);
  }
  // Steps carry `{channel}`/`{tools}` path placeholders (their filenames are the scaffold's private
  // knowledge) — resolve them to the real workspace-relative locations (agentDir-aware) here.
  const kitPrefix = channelHome === target ? "" : `${relative(target, channelHome)}/`;
  for (const s of steps) {
    console.error(`    ${s.replace("{channel}", relative(target, file)).replace("{tools}", `${kitPrefix}tools`)}`);
  }
  if (channelKind !== "lark") {
    console.error(`    fastagent dev --tunnel   # serve locally + a public URL, auto-registering the webhook`);
  }
  // The app-creation flow leaves keep-alive sockets behind (platform API fetches, the throwaway tunnel's
  // health probes) that would hold the event loop open for a while — the work is done, exit crisply.
  process.exit(0);
}

/** `fastagent add skill <source> [dir]`: vendor an Agent Skills skill into <dir>/skills/<name>/. */
export async function runAddSkill(
  source: string | undefined,
  dirArg: string,
  opts: { update?: boolean },
): Promise<void> {
  const target = resolve(dirArg);
  if (!source) {
    // A missing source is a usage error (exit 2), but the guide is worth more than a bare
    // missing-argument line — the common path (writing your own skill) needs no command at all.
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
  // Skills are agent surface — vendored into agentDir/skills (config.agentDir, or target when flat).
  const { config: skillConfig } = await loadConfig(target).catch(failStartup);
  const skillHome = resolveAgentDir(target, skillConfig);
  const { name, description, dest, hasScripts, diagnostics, overwritten } = await vendorSkill(skillHome, source, {
    update: opts.update ?? false,
  }).catch(failStartup);
  console.error(`[fastagent] ${overwritten ? "updated" : "vendored"} skill "${name}" → ${dest}/`);
  if (overwritten) console.error(`  overwrote it — \`git diff ${dest}\` to review, \`git checkout ${dest}\` to revert`);
  if (description) console.error(`  ${description.length > 100 ? `${description.slice(0, 100)}…` : description}`);
  for (const d of diagnostics) console.error(`  warn: ${d.message}`);
  if (hasScripts) {
    console.error(
      `  warn: this skill ships scripts/ (executable code that runs in your agent) — review it before deploying`,
    );
  }
  console.error(`  next: mention "${name}" in persona.md so the model knows when to use it; then \`fastagent dev\``);
}
