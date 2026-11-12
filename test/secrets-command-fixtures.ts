import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace } from "./cli-run.ts";

/** A channel that declares what a deployment needs: GH_TOKEN required, SENTRY_DSN optional. */
const HOOK = `export default {
  kind: "fastagent.needs",
  secrets: [{ name: "GH_TOKEN", optional: false }, { name: "SENTRY_DSN", optional: true }],
  build: () => () => ({ "POST /hook": () => new Response("ok") }),
};\n`;

export async function agent(files: Record<string, string> = {}) {
  return agentWorkspace("fa-secrets-", {
    "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    "src/channels/hook.mjs": HOOK,
    ...files,
  });
}

export const read = (file: string) => readFile(file, "utf8");

/** A `fly` on PATH that answers what the store asks of it and keeps what it was given. */
export async function fakeFly(listed: string[] = ["GH_TOKEN"]) {
  const bin = await mkdtemp(join(tmpdir(), "fa-fake-fly-"));
  const log = join(bin, "log");
  await writeFile(
    join(bin, "fly"),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  version) echo "fly v0";;
  apps) if [ "$2" = "list" ]; then
      if [ -n "$FAKE_FLY_APP_EXISTS" ] || [ -f "${log}.created" ]; then echo '[{"Name":"'"$FAKE_FLY_APP"'"}]'; else echo '[]'; fi
    else touch "${log}.created"; echo "New app created"; fi;;
  secrets)
    # Like flyctl: an app that was never made has no secrets to list.
    if [ "$2" = "list" ]; then
      if [ ! -f "${log}.created" ] && [ -z "$FAKE_FLY_APP_EXISTS" ]; then echo "Error: app not found" >&2; exit 1; fi
      echo '[${listed.map((name) => `{"Name":"${name}"}`).join(",")}]'
    fi
    if [ "$2" = "set" ]; then cat >> "${log}.stdin"; echo >> "${log}.stdin"; echo "Secrets are staged"; fi;;
esac
`,
  );
  await chmod(join(bin, "fly"), 0o755);
  return {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } as NodeJS.ProcessEnv,
    calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
    stdin: async () => readFile(`${log}.stdin`, "utf8").catch(() => undefined),
  };
}

/** An `aws` on PATH with one Secrets Manager secret in a file: absent until `create-secret`, as the CLI answers. */
export async function fakeAws(initial?: string) {
  const bin = await mkdtemp(join(tmpdir(), "fa-fake-aws-"));
  const log = join(bin, "log");
  const secret = join(bin, "secret");
  if (initial !== undefined) await writeFile(secret, initial);
  await writeFile(
    join(bin, "aws"),
    `#!/bin/sh
echo "$@" >> "${log}"
[ "$1" = secretsmanager ] || exit 1
case "$2" in
  describe-secret)
    [ -f "${secret}" ] || { echo "An error occurred (ResourceNotFoundException) when calling DescribeSecret" >&2; exit 254; }
    case "$*" in *ARN*) echo "arn:aws:secretsmanager:us-west-2:1:secret:fastagent/x-AbCdEf";; *) echo '{"Name":"x"}';; esac;;
  create-secret) echo '{}' > "${secret}"; echo '{"Name":"x"}';;
  get-secret-value) cat "${secret}"; echo;;
  put-secret-value) for last; do :; done; cp "\${last#file://}" "${secret}"; echo '{"VersionId":"v"}';;
esac
`,
  );
  await chmod(join(bin, "aws"), 0o755);
  return {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
    held: async () => readFile(secret, "utf8").catch(() => undefined),
  };
}

export const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
