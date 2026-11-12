import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { agentWorkspace } from "./cli-run.ts";
import { hostCli } from "./host-cli-double.ts";

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

/** A `fly` that answers what the store asks of it and keeps what it was given; `app` is an app that already exists. */
export function fakeFly(listed: string[] = ["GH_TOKEN"], options: { app?: string } = {}) {
  const calls: string[] = [];
  let created = false;
  let stdin: string | undefined;
  hostCli("fly", ({ args, input }) => {
    calls.push(args.join(" "));
    const [command, sub] = args;
    if (command === "version") return { stdout: "fly v0\n" };
    if (command === "apps" && sub === "list") {
      return { stdout: options.app !== undefined || created ? `[{"Name":"${options.app ?? ""}"}]\n` : "[]\n" };
    }
    if (command === "apps") {
      created = true;
      return { stdout: "New app created\n" };
    }
    // Like flyctl: an app that was never made has no secrets to list.
    if (command === "secrets" && sub === "list") {
      if (!created && options.app === undefined) return { code: 1, stderr: "Error: app not found\n" };
      return { stdout: `[${listed.map((name) => `{"Name":"${name}"}`).join(",")}]\n` };
    }
    if (command === "secrets" && sub === "set") {
      stdin = `${stdin ?? ""}${input ?? ""}\n`;
      return { stdout: "Secrets are staged\n" };
    }
    return {};
  });
  return { calls: () => calls, stdin: () => stdin };
}

/** An `aws` with one Secrets Manager secret: absent until `create-secret`, as the CLI answers. */
export function fakeAws(initial?: string) {
  const calls: string[] = [];
  let secret = initial;
  hostCli("aws", ({ args }) => {
    calls.push(args.join(" "));
    if (args[0] !== "secretsmanager") return { code: 1 };
    switch (args[1]) {
      case "describe-secret":
        if (secret === undefined) {
          return { code: 254, stderr: "An error occurred (ResourceNotFoundException) when calling DescribeSecret\n" };
        }
        return {
          stdout: args.join(" ").includes("ARN")
            ? "arn:aws:secretsmanager:us-west-2:1:secret:fastagent/x-AbCdEf\n"
            : '{"Name":"x"}\n',
        };
      case "create-secret":
        secret = "{}";
        return { stdout: '{"Name":"x"}\n' };
      case "get-secret-value":
        return { stdout: `${secret ?? ""}\n` };
      case "put-secret-value":
        secret = readFileSync((args.at(-1) as string).replace(/^file:\/\//, ""), "utf8");
        return { stdout: '{"VersionId":"v"}\n' };
      default:
        return {};
    }
  });
  return { calls: () => calls, held: () => secret };
}

export const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
