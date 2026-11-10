/** MCP inspection, explicit sign-in and local binding removal. */
import { confirm, isCancel } from "@clack/prompts";
import { inspectMcp, mcpContext, writeMcpBinding, httpServer } from "../../mcp/host.ts";
import { signInMcp } from "../../mcp/sign-in.ts";
import { holdingInstance } from "../../harnesses/pi-durable/serve.ts";
import { declareMcp, mcpInstance, resolveMcpServers } from "../../mcp/config.ts";
import { devInstanceConfig, namedInstanceConfig } from "../../harnesses/pi-durable/config.ts";
import { McpError } from "../../mcp-api.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { enterAgentEnv } from "../../env.ts";
import { openExternalUrl } from "../../open-url.ts";
import { shellArg } from "../../shell-arg.ts";
import { isInteractive } from "../shared.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import {
  checkTicket,
  refusedCheck,
  runTicket,
  startTicket,
  ticketExitCode,
  ticketReport,
  printReport,
  type TicketStep,
  type Ticket,
} from "../ticket.ts";

export interface McpCommandOptions {
  json?: boolean;
  environment?: string;
  scopes?: string;
  timeout?: string;
  clientId?: string;
  callbackPort?: string;
  check?: string;
  ticket?: string;
  input?: boolean;
}
const CHECK = "fastagent mcp login --check";
function report(ticket: Ticket, json: boolean, when: "started" | "checked") {
  const result = ticketReport(ticket, when, (value) => ({
    fields: value,
    text: ["MCP authorization saved and bound; reopen the agent to use it"],
    next: "Reopen the agent to use its MCP tools.",
  }));
  printReport(json, result.json, result.text);
}

export async function runMcp(
  action: "list" | "login" | "disconnect",
  server: string | undefined,
  dir: string,
  options: McpCommandOptions,
): Promise<void> {
  if (options.check) {
    const refusal = refusedCheck(options.check, CHECK);
    if (refusal) return failUsage(refusal);
    const ticket = await checkTicket(options.check);
    if (!ticket) return failUsage("MCP sign-in ticket not found");
    report(ticket, !!options.json, "checked");
    process.exit(ticketExitCode(ticket));
  }
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
  const config = instance?.label;
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
  if (unattended && scopes === undefined)
    return failUsage(
      "mcp login without a terminal needs --scopes <comma-separated-scopes>; consult the MCP service's authorization requirements",
    );
  const run = async (step?: TicketStep) => {
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
        signal: step?.signal,
        async confirmAuthorization(request) {
          const message = `Authorize ${request.server} at ${request.issuer} for ${request.scopes.join(", ") || "server-defined scopes"}?`;
          if (step) {
            console.error(`[fastagent] ${message}`);
            return true;
          }
          const choice = await confirm({ message, initialValue: false });
          return !isCancel(choice) && choice;
        },
        notify(event) {
          if (event.type === "auth_url") {
            const instructions = `Authorize the MCP server ${server} in your browser; scope: ${scopes?.join(", ") ?? "as approved"}. The callback is on the machine running this command; do not paste codes into chat.`;
            if (step) step.person.waitsOn(event.url, instructions);
            else {
              console.error(`${instructions}\n${event.url}`);
              openExternalUrl(event.url);
            }
          } else {
            step?.person.carriesOn();
            console.error(`[fastagent] ${event.message}`);
          }
        },
      },
    });
    await writeMcpBinding(context.stateRoot, server, grant.id);
    return { server, grant_id: grant.id, scopes: grant.scopes };
  };
  if (options.ticket) {
    await runTicket(options.ticket, (step) => run(step));
    process.exit(0);
  }
  if (unattended && scopes !== undefined) {
    const args = [
      process.argv[1] as string,
      "mcp",
      "login",
      server,
      target,
      "--env",
      environment,
      "--scopes",
      scopes.join(","),
      "--timeout",
      String(seconds),
    ];
    if (options.clientId) args.push("--client-id", options.clientId);
    if (options.callbackPort) args.push("--callback-port", options.callbackPort);
    const ticket = await startTicket({
      subject: `mcp:login:${environment}:${target}:${server}`,
      action: `authorize MCP server ${server}`,
      check: CHECK,
      restart: `fastagent ${args.slice(1).map(shellArg).join(" ")}`,
      timeoutSeconds: seconds,
      whenRunning: "replace",
      waitsFirst: false,
      command: { file: process.execPath, args: [...process.execArgv, ...args], cwd: process.cwd() },
    });
    report(ticket, !!options.json, "started");
    process.exit(ticketExitCode(ticket));
  }
  const result = await run().catch((error) => {
    if (error instanceof McpError && error.code === "canceled") return failUsage(error.message);
    return failStartup(error);
  });
  printReport(!!options.json, { status: "done", ...result }, [
    "MCP authorization saved and bound; reopen the agent to use it",
  ]);
}
