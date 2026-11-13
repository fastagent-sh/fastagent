/** MCP inspection, explicit sign-in and local binding removal. */
import { confirm, isCancel } from "@clack/prompts";
import { inspectMcp, mcpContext, writeMcpBinding, httpServer } from "../../mcp/host.ts";
import { signInMcp } from "../../mcp/sign-in.ts";
import { holdingInstance } from "../../harnesses/pi-durable/serve.ts";
import { declareMcp, mcpInstance, resolveMcpServers } from "../../mcp/config.ts";
import { devInstanceConfig, mcpConfigOf, namedInstanceConfig } from "../../harnesses/pi-durable/config.ts";
import { McpError } from "../../mcp-api.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { enterAgentEnv } from "../../env.ts";
import { openExternalUrl } from "../../open-url.ts";
import { shellArg } from "../../shell-arg.ts";
import { isInteractive, printReport } from "../shared.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";

export interface McpCommandOptions {
  json?: boolean;
  environment?: string;
  scopes?: string;
  timeout?: string;
  clientId?: string;
  callbackPort?: string;
  input?: boolean;
}

export async function runMcp(
  action: "list" | "login" | "disconnect",
  server: string | undefined,
  dir: string,
  options: McpCommandOptions,
): Promise<void> {
  const target = agentDirOrExit(dir);
  const environment = options.environment ?? "dev";
  if (environment !== "dev" && environment !== "production") return failUsage("--env must be dev or production");
  selectAgentEnvironment(environment);
  enterAgentEnv(target);
  // The servers the instance of this environment opens: the program's, and what its configuration adds. `dev` reads the
  // one `--config` names or else the project's; `start` never reads the project's.
  const instance = await (environment === "production" ? namedInstanceConfig() : devInstanceConfig(target)).catch(
    failStartup,
  );
  const config = instance === undefined ? undefined : mcpConfigOf(instance);
  if (action === "list") {
    const servers = await inspectMcp(target, config === undefined ? {} : { config }).catch(failStartup);
    if (options.json) console.log(JSON.stringify(servers));
    else for (const item of servers) console.log(`${item.name}\t${item.transport}\t${item.authorization}`);
    return;
  }
  if (!server)
    return failUsage(
      `mcp ${action} needs a server name from the program's context.json or the instance's fastagent.json`,
    );
  const context = mcpContext(target);
  if (action === "disconnect") {
    await holdingInstance(context.stateRoot, () => writeMcpBinding(context.stateRoot, server, undefined)).catch(
      failStartup,
    );
    printReport(
      !!options.json,
      {
        status: "done",
        server,
        grant_revoked: false,
        agent_next_steps:
          "The instance binding was removed. The stored grant was not revoked; reauthorize or update the server's declaration before reopening.",
      },
      [
        "Binding removed; the stored grant was not revoked. Reauthorize or update the server's declaration before reopening.",
      ],
    );
    return;
  }
  httpServer(
    resolveMcpServers(declareMcp(target, mcpInstance(config)), context.environment, server, target, {}),
    server,
  );
  const seconds = options.timeout === undefined ? 900 : Number(options.timeout);
  if (!Number.isInteger(seconds) || seconds <= 0)
    return failUsage("--timeout must be a positive whole number of seconds");
  const scopes = options.scopes
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unattended = options.json || options.input === false || !isInteractive();
  if (unattended) {
    const scopeArg = scopes?.length ? ` --scopes ${shellArg(scopes.join(","))}` : "";
    const envArg = environment === "dev" ? "" : ` --env ${environment}`;
    const cmd = `fastagent mcp login ${shellArg(server)} ${shellArg(target)}${envArg}${scopeArg}`;
    printReport(
      options.json,
      {
        status: "need_user_action",
        server,
        terminal_command: cmd,
        check_command: `fastagent mcp list ${shellArg(target)}${envArg} --json`,
        agent_next_steps:
          "Ask the user to run terminal_command in a terminal of their own to complete the browser OAuth flow, then run check_command.",
      },
      [`need_user_action: run in an interactive terminal: ${cmd}`],
    );
    process.exit(2);
  }
  const grant = await signInMcp({
    agentDir: target,
    ...(config === undefined ? {} : { config }),
    server,
    store: context.auth.store,
    scopes,
    clientId: options.clientId,
    callbackPort: options.callbackPort === undefined ? undefined : Number(options.callbackPort),
    timeoutSeconds: seconds,
    interaction: {
      async confirmAuthorization(request) {
        const message = `Authorize ${request.server} at ${request.issuer} for ${request.scopes.join(", ") || "server-defined scopes"}?`;
        const choice = await confirm({ message, initialValue: false });
        return !isCancel(choice) && choice;
      },
      notify(event) {
        if (event.type === "auth_url") {
          const instructions = `Authorize the MCP server ${server} in your browser; scope: ${scopes?.join(", ") ?? "as approved"}. The callback is on the machine running this command; do not paste codes into chat.`;
          console.error(`${instructions}\n${event.url}`);
          openExternalUrl(event.url);
        } else {
          console.error(`[fastagent] ${event.message}`);
        }
      },
    },
  }).catch((error) => {
    if (error instanceof McpError && error.code === "canceled") return failUsage(error.message);
    return failStartup(error);
  });
  await writeMcpBinding(context.stateRoot, server, grant.id);
  printReport(!!options.json, { status: "done", server, grant_id: grant.id, scopes: grant.scopes }, [
    "MCP authorization saved and bound; reopen the agent to use it",
  ]);
}
