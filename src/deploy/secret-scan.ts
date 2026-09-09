/**
 * WHICH ENV NAMES THE AGENT'S OWN CODE READS that a deploy would not carry — so a forgotten
 * `deploy.secrets` entry surfaces at `fastagent info` / deploy pre-flight time, not days later as an
 * undefined token on the box's first real tool call.
 *
 * A STATIC regex over the sources under `tools/`, `schedules/` and `channels/`: nothing is imported or
 * executed (the pre-flight already loads channels for their ingress; this must also answer for a tool
 * whose top-level import would fail on the builder machine). The ceiling that buys: a computed name
 * (`process.env[`X_${k}`]`), a destructured one (`const { X } = process.env`) and a name reached
 * through an alias are invisible, and a name inside a comment or string counts as a read. Both errors
 * are cheap — a missed name leaves the author exactly where they are today, and a false positive is
 * silenced by listing the name in `deploy.secrets`, where a value the box needs belongs anyway.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { moduleInventory } from "../loader.ts";
import { CHANNEL_KINDS, type ChannelKind, channelSetup } from "../scaffold/add-channel.ts";

/** The code-input dirs whose files run ON THE BOX — where a missing secret becomes a runtime failure. */
const CODE_INPUT_DIRS = ["tools", "schedules", "channels"];

/** `process.env.NAME` and `process.env["NAME"]` — the two spellings a hand-written module uses. */
const ENV_READ = /process\.env(?:\.([A-Za-z_$][\w$]*)|\s*\[\s*["']([^"']+)["']\s*\])/g;

/** Provided by the runtime/host, never by a deploy secret — a read of one is not a missing name.
 *  Compared case-insensitively so the lowercase proxy spellings are covered by one entry each. */
const RUNTIME_ENV = new Set([
  "PORT",
  "NODE_ENV",
  "HOME",
  "PATH",
  "PWD",
  "TMPDIR",
  "TZ",
  "CI",
  "USER",
  "SHELL",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

/** One file's reads that nothing declares. */
export interface EnvReadFinding {
  /** "tools/x-post.ts"-style label, as every other code-input diagnostic names its file. */
  label: string;
  names: string[];
}

/** Env names the first-party channel adapters declare — carried by deploy without being listed.
 *  BOTH ingress modes, since which one is configured does not change what the file may read. */
function channelSecretNames(channels: readonly string[]): string[] {
  return channels.flatMap((name) =>
    (CHANNEL_KINDS as string[]).includes(name)
      ? (["webhook", "websocket"] as const).flatMap((mode) =>
          channelSetup(name as ChannelKind, mode).env.map((e) => e.name),
        )
      : [],
  );
}

/**
 * Scan the agent's code inputs and report the env names neither `declared` (config `deploy.secrets`
 * plus whatever the caller knows deploy carries, e.g. the model key), declared by a first-party
 * channel adapter, nor supplied by the runtime. Throws only on a real fault (an unreadable file).
 */
export async function undeclaredEnvReads(input: {
  agentDir: string;
  /** Discovered channel basenames — first-party ones bring their adapter's secret names with them. */
  channels: readonly string[];
  declared: readonly string[];
}): Promise<EnvReadFinding[]> {
  const known = new Set([...input.declared, ...channelSecretNames(input.channels)]);
  const findings: EnvReadFinding[] = [];
  for (const dir of CODE_INPUT_DIRS) {
    for (const entry of await moduleInventory(join(input.agentDir, dir))) {
      const source = await readFile(entry.file, "utf8");
      const names = [...new Set([...source.matchAll(ENV_READ)].map((m) => m[1] ?? m[2] ?? ""))].filter(
        (name) =>
          name !== "" && !known.has(name) && !name.startsWith("FASTAGENT_") && !RUNTIME_ENV.has(name.toUpperCase()),
      );
      if (names.length > 0) findings.push({ label: entry.label, names });
    }
  }
  return findings;
}

/** The one wording both `info` and the deploy pre-flight print, so they cannot drift. */
export function envReadWarning(finding: EnvReadFinding): string {
  return (
    `${finding.label} reads ${finding.names.join(", ")} — not in config.deploy.secrets, so a deployed ` +
    `box would read undefined. Add the names there (or ignore this if the value is local-only).`
  );
}
