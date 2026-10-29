/**
 * An account sign-in a coding agent starts and a person finishes. A coding agent works in turns: it runs a command,
 * reads what it printed, then talks to its user. So the sign-in outlives the command that starts it, as Netlify's
 * `login --request`/`--check` and Dosu's login tickets have it: `fastagent login` starts a process of its own that runs
 * the provider's sign-in and keeps a ticket up to date, and returns as soon as there is an address for the person to
 * open. `login --check <ticket>` reads where it stands from any process, and hands the sign-in the address a browser
 * ended on when that browser could not reach this machine.
 *
 * A ticket is a file in the machine's own state, ~/.fastagent/.state/logins, written whole by one process at a time:
 * the starting command until the sign-in starts, then the sign-in alone.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { writeFileAtomic } from "../atomic-write.ts";
import { STATE_DIRNAME, globalHome } from "../paths.ts";

type TicketStatus = "starting" | "need_user_action" | "authorized" | "failed" | "expired";

export interface Ticket {
  ticket: string;
  provider: string;
  /** The provider's name, as the sign-in menus show it. */
  name: string;
  authPath: string;
  status: TicketStatus;
  /** When the sign-in gives up (ms since the epoch). */
  expiresAt: number;
  /** The process running the sign-in. */
  pid?: number;
  /** Where the person signs in. */
  url?: string;
  /** What they enter there, for a device sign-in. */
  code?: string;
  /** The provider's own instructions for the step. */
  instructions?: string;
  /** Why the sign-in failed. */
  message?: string;
  /** pi's default model for the provider, for an agent with none. */
  model?: string;
}

/** How long a starting sign-in may take to produce an address before the starting command gives up on it. */
const START_TIMEOUT_MS = 30_000;
/** How long `--check` waits for a sign-in to take the address it was handed. */
const ADDRESS_TIMEOUT_MS = 15_000;
const POLL_MS = 200;
/** Ticket files are random hex: anything else names no ticket, and no file outside the directory. */
const TICKET_ID = /^[0-9a-f]{16}$/;

const ticketsDir = () => join(globalHome(), STATE_DIRNAME, "logins");
const ticketPath = (id: string) => join(ticketsDir(), `${id}.json`);
const addressPath = (id: string) => join(ticketsDir(), `${id}.address`);
/** What the sign-in's process says while it runs: the place to look when it fails. */
export const ticketLogPath = (id: string) => join(ticketsDir(), `${id}.log`);

function readTicket(id: string): Ticket | undefined {
  if (!TICKET_ID.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(ticketPath(id), "utf8")) as Ticket;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const writeTicket = (ticket: Ticket): void => writeFileAtomic(ticketPath(ticket.ticket), JSON.stringify(ticket));

function update(id: string, change: Partial<Ticket>): Ticket {
  const current = readTicket(id);
  if (current === undefined) throw new Error(`login ticket ${id} is gone from ${ticketsDir()}`);
  const next = { ...current, ...change };
  writeTicket(next);
  return next;
}

/** Whether the process `pid` still runs: signal 0 delivers nothing and only says whether it could. */
function running(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tickets a day past their end: each one's files go. */
function prune(now: number): void {
  if (!existsSync(ticketsDir())) return;
  for (const file of readdirSync(ticketsDir())) {
    const id = file.slice(0, 16);
    const ticket = TICKET_ID.test(id) ? readTicket(id) : undefined;
    if (ticket !== undefined && ticket.expiresAt < now - 24 * 60 * 60 * 1000) {
      for (const path of [ticketPath(id), addressPath(id), ticketLogPath(id)]) rmSync(path, { force: true });
    }
  }
}

interface TicketRequest {
  provider: string;
  name: string;
  authPath: string;
  timeoutSeconds: number;
}

/** A new ticket, its sign-in not started yet. Not public: what `startTicket` starts, and a test seam. */
export function createTicket(request: TicketRequest): Ticket {
  const now = Date.now();
  prune(now);
  mkdirSync(ticketsDir(), { recursive: true });
  const ticket: Ticket = {
    ticket: randomBytes(8).toString("hex"),
    provider: request.provider,
    name: request.name,
    authPath: request.authPath,
    status: "starting",
    expiresAt: now + request.timeoutSeconds * 1000,
  };
  writeTicket(ticket);
  return ticket;
}

/**
 * Start a sign-in in a process of its own (`args`: the `fastagent login` that runs it, given the ticket's id last) and
 * return its ticket once it has an address for the person, or has ended.
 */
export async function startTicket(
  input: TicketRequest & {
    /** The command that runs the sign-in, its arguments, and the directory it runs in; `--ticket <id>` is added. */
    command: { file: string; args: readonly string[]; cwd: string };
  },
): Promise<Ticket> {
  const id = createTicket(input).ticket;
  const log = openSync(ticketLogPath(id), "a");
  const child = spawn(input.command.file, [...input.command.args, "--ticket", id], {
    cwd: input.command.cwd,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  closeSync(log);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();
  for (const deadline = Date.now() + START_TIMEOUT_MS; Date.now() < deadline; ) {
    const ticket = readTicket(id) as Ticket;
    if (ticket.status !== "starting") return ticket;
    if (exited) break;
    await sleep(POLL_MS);
  }
  const ticket = readTicket(id) as Ticket;
  if (ticket.status !== "starting") return ticket;
  return update(id, {
    status: "failed",
    message: exited
      ? `the sign-in stopped before it started: ${ticketLogPath(id)} says why`
      : `the sign-in gave no address to open within ${START_TIMEOUT_MS / 1000}s: ${ticketLogPath(id)} says why`,
  });
}

/**
 * Where the sign-in `id` stands. `address`: what the person's browser ended on (or the code the provider's page
 * showed), for a sign-in waiting on it; it is handed over, and the answer is the ticket once the sign-in has taken it.
 */
export async function checkTicket(id: string, address?: string): Promise<Ticket | undefined> {
  let ticket = readTicket(id);
  if (ticket === undefined) return undefined;
  if (address !== undefined && ticket.status === "need_user_action") {
    writeFileAtomic(addressPath(id), address);
    for (const deadline = Date.now() + ADDRESS_TIMEOUT_MS; Date.now() < deadline; ) {
      ticket = readTicket(id) as Ticket;
      if (ticket.status !== "need_user_action" || !running(ticket.pid)) break;
      await sleep(POLL_MS);
    }
  }
  if ((ticket.status === "starting" || ticket.status === "need_user_action") && !running(ticket.pid)) {
    return Date.now() > ticket.expiresAt
      ? update(id, { status: "expired" })
      : update(id, { status: "failed", message: `the sign-in stopped: ${ticketLogPath(id)} says why` });
  }
  return ticket;
}

/**
 * The sign-in of ticket `id`, in the process `startTicket` started: `run` signs in through the interaction given to
 * it, which no person answers. A choice takes its first option, pi's default (the browser sign-in); a text question is
 * left blank, the one pi-ai's account sign-ins ask being Copilot's optional Enterprise domain (a required one fails in
 * the provider's own flow, which the ticket reports); a secret it cannot take; the code or address a browser ends on
 * comes from `login --check --code`, unless the provider's callback brings it first.
 */
export async function runTicket(
  id: string,
  run: (interaction: AuthInteraction) => Promise<{ model?: string }>,
): Promise<void> {
  const ticket = readTicket(id);
  if (ticket === undefined) throw new Error(`no login ticket ${id} in ${ticketsDir()}`);
  update(id, { pid: process.pid });
  const signal = AbortSignal.timeout(Math.max(0, ticket.expiresAt - Date.now()));
  const interaction: AuthInteraction = {
    signal,
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "select") return (prompt.options[0] as { id: string }).id;
      if (prompt.type === "text") return "";
      if (prompt.type === "secret") {
        throw new Error(
          `the sign-in asks "${prompt.message}", which only a terminal can answer: run \`fastagent login ` +
            `${ticket.provider}\` in one`,
        );
      }
      return awaitAddress(id, prompt.signal ? AbortSignal.any([prompt.signal, signal]) : signal);
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        update(id, {
          status: "need_user_action",
          url: event.url,
          ...(event.instructions ? { instructions: event.instructions } : {}),
        });
      } else if (event.type === "device_code") {
        update(id, { status: "need_user_action", url: event.verificationUri, code: event.userCode });
      }
      console.error(`[fastagent] ${event.type}: ${"message" in event ? event.message : ""}`);
    },
  };
  try {
    const { model } = await run(interaction);
    update(id, { status: "authorized", ...(model === undefined ? {} : { model }) });
  } catch (error) {
    if (signal.aborted) update(id, { status: "expired" });
    else update(id, { status: "failed", message: (error as Error).message });
  }
}

/** The address `login --check --code` hands over, once it does; undefined when `signal` aborts first. */
async function awaitAddress(id: string, signal: AbortSignal): Promise<string> {
  while (!signal.aborted) {
    if (existsSync(addressPath(id))) {
      const address = readFileSync(addressPath(id), "utf8");
      rmSync(addressPath(id), { force: true });
      return address;
    }
    await sleep(POLL_MS);
  }
  throw new Error("the sign-in no longer waits for an address");
}
