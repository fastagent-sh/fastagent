import { agentWorkspace } from "../../doubles/cli-run.ts";
import { hostCli } from "../../doubles/host-cli-double.ts";

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

export const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
