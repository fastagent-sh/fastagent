/**
 * Logging a deployment in on the deployment itself: `fastagent login --stdio` runs on the box through the host's own
 * owner-authenticated shell (deploy/box-shell.ts), and this terminal renders it (login-relay.ts). The box creates and
 * keeps the credential, so it is the only holder of its grant, and logging in again replaces it there. Nothing is
 * copied from this machine.
 */
import { type Server, createServer } from "node:http";
import { type BoxShell, deploymentLoginCommand } from "../deploy/box-shell.ts";
import { boxLoginCommand } from "../deploy/container.ts";
import type { DeployHost } from "../deploy/hosts.ts";
import type { LoginIO } from "../harnesses/models/login.ts";
import type { SignInMethod } from "../sign-in-api.ts";
import { relayLogin } from "./login-relay.ts";
import { terminalLoginIO } from "./shared.ts";
import type { TicketStep } from "./ticket.ts";

export interface BoxLoginRequest {
  host: DeployHost;
  shell: BoxShell;
  /** Skip the provider menu. */
  provider?: string;
  /** Skip the method menu. */
  method?: SignInMethod;
  /** Keep a credential the box already holds for `provider` (a redeploy), instead of replacing it. */
  ifMissing?: boolean;
  /** false: never ask; a box without the credential is a failure naming the command to run in a terminal. */
  input: boolean;
  /** Who answers what the box asks: this terminal by default, or a ticket's process ({@link ticketLoginIO}). */
  io?: LoginIO;
}

/**
 * Run the login on the box and report its outcome. Resolves `undefined` once the box reports a credential for the
 * provider (logged in now, or kept), else with the one line saying why not and what to run.
 */
export async function loginOnBox(request: BoxLoginRequest): Promise<string | undefined> {
  const { host, shell, provider } = request;
  const retry = deploymentLoginCommand(host, provider);
  const args = [
    ...(provider ? [provider] : []),
    ...(request.method ? ["--method", request.method === "oauth" ? "account" : "api-key"] : []),
    ...(request.ifMissing ? ["--if-missing"] : []),
    ...(request.input ? [] : ["--no-input"]),
  ];
  let command: string;
  try {
    command = boxLoginCommand(args, shell.storage);
  } catch (error) {
    return (error as Error).message;
  }
  // A wake that fails is this login's answer, in one line, like an `open` that fails below.
  const woken = await shell.wake?.().catch((error: Error) => error);
  if (woken instanceof Error) return woken.message;
  const channel = await shell.open(command).catch((error: Error) => error);
  if (channel instanceof Error) return channel.message;
  const io = catchingRedirect(request.io ?? terminalLoginIO());
  const result = await relayLogin(channel.output, channel.input, io, (line) => console.error(line)).finally(io.close);
  const closed = await channel.closed;
  if (!closed.opened) return closed.error;
  if (!result) {
    return (
      `the ${host} shell ended without a login result (${closed.how}) — nothing on the box says it is logged in. ` +
      `See the output above, then run \`${retry}\``
    );
  }
  if (result.ok) {
    console.error(
      "kept" in result
        ? `[fastagent] the deployment already authenticates ${result.provider} (${result.kept}) — kept`
        : `[fastagent] logged in to ${result.provider} (${result.method}) on the deployment — saved to ${result.path} there`,
    );
    return undefined;
  }
  if (result.reason === "missing") {
    const forAgent = provider
      ? `fastagent login ${provider} --method account --deployment ${host} --json`
      : `${retry} --json`;
    return (
      `not logged in: ${result.message} — run \`${retry}\` in a terminal, or \`${forAgent}\` from a coding agent, ` +
      `which hands the sign-in to its user`
    );
  }
  if (result.reason === "cancelled") return `login on the deployment cancelled — run \`${retry}\` to log it in`;
  return `login on the deployment failed: ${result.message}`;
}

const CAUGHT_PAGE =
  "<!doctype html><meta charset=utf-8><title>fastagent</title>" +
  "<p>fastagent received the sign-in and sent it to your deployment. Return to your terminal.</p>";

/**
 * A box's sign-in answered by a ticket's process, with no one at a terminal: what the person does is the ticket's
 * (`need_user_action`), and what the box asks is answered as {@link signInInteraction} answers a local sign-in. A choice
 * takes its first option, pi's default; a text question is left blank; the address the browser ended on comes from
 * `login --check --code` (or the redirect {@link catchingRedirect} catches first); a secret it cannot take, and
 * `refusal` says so, since the box only hears that the question was backed out of.
 */
export function ticketLoginIO(step: TicketStep, retry: string): LoginIO & { refusal(): string | undefined } {
  let refusal: string | undefined;
  return {
    refusal: () => refusal,
    select: async (_message, options) => options[0]?.value,
    async prompt(message, opts) {
      if (opts?.hidden) {
        refusal = `the sign-in asks "${message}", which only a terminal can answer: run \`${retry}\` in one`;
        return undefined;
      }
      if (!opts?.redirect) return "";
      const address = await step
        .address(opts.signal ? AbortSignal.any([opts.signal, step.signal]) : step.signal)
        .catch(() => undefined);
      if (address !== undefined) step.person.carriesOn();
      return address;
    },
    note: (message) => console.error(`[fastagent] ${message}`),
    openUrl: (url, userCode) => step.waits(userCode ? { url, code: userCode } : { url, takesAddress: true }),
  };
}

/**
 * A browser OAuth flow sends the owner's browser back to its `redirect_uri`: a localhost address, which on the owner's
 * machine has nothing of the box behind it. So catch it here. While an authorization URL naming such a redirect is
 * open, listen on that address (the port the provider fixed, loopback only, as pi's own flows do), and answer the
 * prompt for that address with the URL the browser brought back, exactly what the person would paste. The prompt
 * stays up meanwhile: a taken port, or a browser on another machine, still leaves pasting.
 */
export function catchingRedirect(io: LoginIO): LoginIO & { close(): void } {
  let server: Server | undefined;
  let caught: string | undefined;
  let deliver: ((url: string) => void) | undefined;
  const close = (): void => {
    server?.close();
    server = undefined;
  };
  const listen = (authUrl: string): void => {
    let redirect: URL;
    let state: string | null;
    try {
      const authorize = new URL(authUrl);
      redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      state = authorize.searchParams.get("state");
    } catch {
      return; // no redirect to catch (a device-code page, or not a URL we can read)
    }
    if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirect.hostname)) return;
    // The flow's `state` is what tells its redirect from anything else that can reach a loopback port: any page open
    // in the browser can request it, and a forged hit taken as the answer would end this login in "State mismatch" and
    // close the port before the real one arrives. Without one there is nothing to tell them apart: leave it to pasting.
    if (!state) return;
    close();
    const listening = createServer((req, res) => {
      const got = new URL(req.url ?? "/", redirect);
      if (
        got.pathname !== redirect.pathname ||
        !got.searchParams.has("code") ||
        got.searchParams.get("state") !== state
      ) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CAUGHT_PAGE);
      close();
      if (deliver) deliver(got.toString());
      else caught = got.toString();
    });
    listening.on("error", (error: NodeJS.ErrnoException) => {
      if (server === listening) server = undefined;
      io.note(
        `could not listen on ${redirect.host} for the browser's redirect (${error.code ?? error.message}) — after ` +
          `signing in, paste the address the browser lands on`,
      );
    });
    listening.listen(Number(redirect.port || 80), "127.0.0.1");
    listening.unref();
    server = listening;
  };
  return {
    select: io.select,
    note: io.note,
    close,
    openUrl(url, userCode) {
      listen(url);
      io.openUrl(url, userCode);
    },
    async prompt(message, opts) {
      if (!opts?.redirect) return io.prompt(message, opts);
      if (caught !== undefined) {
        const url = caught;
        caught = undefined;
        return url;
      }
      if (!server) return io.prompt(message, opts);
      const typed = new AbortController();
      const signal = opts?.signal ? AbortSignal.any([opts.signal, typed.signal]) : typed.signal;
      const fromBrowser = new Promise<string>((resolve) => {
        deliver = resolve;
      });
      try {
        // Settle the race BEFORE aborting the terminal prompt: aborting it settles its promise too.
        const won = await Promise.race([
          io.prompt(message, { ...opts, signal }).then((value) => ({ typed: value })),
          fromBrowser.then((url) => ({ url })),
        ]);
        if ("typed" in won) return won.typed;
        typed.abort();
        io.note("received the browser's redirect");
        return won.url;
      } finally {
        deliver = undefined;
      }
    },
  };
}
