/**
 * An account sign-in a coding agent starts and a person finishes. A coding agent works in turns: it runs a command,
 * reads what it printed, then talks to its user. So the sign-in outlives the command that starts it, as Netlify's
 * `login --request`/`--check` and Dosu's login tickets have it: `fastagent login` starts a process of its own that runs
 * the provider's sign-in and keeps a ticket up to date, and returns as soon as there is an address for the person to
 * open. `login --check <ticket>` reads where it stands from any process, and hands the sign-in the address a browser
 * ended on when that browser could not reach this machine.
 *
 * A ticket is a file in the machine's own state, ~/.fastagent/.state/logins, written whole by one process at a time:
 * the starting command until the sign-in starts, then the sign-in alone. One that has ended stays as it ended. A newer
 * sign-in to the same provider stops an older one still waiting, whose process would otherwise hold the provider's
 * callback port (OpenAI's is fixed) until it expires.
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
/** How long a stopped sign-in's process has to let go of its port before it is killed. */
const STOP_TIMEOUT_MS = 5_000;
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

const waiting = (ticket: Ticket) => ticket.status === "starting" || ticket.status === "need_user_action";

/**
 * Change the ticket `id` while its sign-in is still waiting; one that has ended is returned as it ended. A writer that
 * read it before it ended (a check that found its process gone the moment it signed in) cannot reopen it.
 */
function update(id: string, change: Partial<Ticket>): Ticket {
  const current = readTicket(id);
  if (current === undefined) throw new Error(`login ticket ${id} is gone from ${ticketsDir()}`);
  if (!waiting(current)) return current;
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

/** Stop a sign-in's process and wait until it is gone, so the port its callback held is free. */
async function stop(pid: number): Promise<void> {
  if (!running(pid)) return;
  process.kill(pid);
  for (const deadline = Date.now() + STOP_TIMEOUT_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    if (!running(pid)) return;
  }
  process.kill(pid, "SIGKILL");
}

/**
 * Stop every sign-in to `provider` still waiting, before a newer one starts. Only an unexpired one is taken for a
 * process of ours: its pid is minutes old, where one an ended process left could by now name another's.
 */
async function supersede(provider: string, name: string, now: number): Promise<void> {
  if (!existsSync(ticketsDir())) return;
  for (const file of readdirSync(ticketsDir())) {
    const ticket = file.endsWith(".json") ? readTicket(file.slice(0, -".json".length)) : undefined;
    if (ticket === undefined || ticket.provider !== provider || !waiting(ticket) || ticket.expiresAt < now) continue;
    if (ticket.pid !== undefined) await stop(ticket.pid);
    update(ticket.ticket, { status: "failed", message: `replaced by a newer sign-in to ${name}` });
  }
}

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
    /** How long the sign-in may take to give an address; a test's is short. */
    startTimeoutMs?: number;
  },
): Promise<Ticket> {
  await supersede(input.provider, input.name, Date.now());
  const id = createTicket(input).ticket;
  const startTimeoutMs = input.startTimeoutMs ?? START_TIMEOUT_MS;
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
  for (const deadline = Date.now() + startTimeoutMs; Date.now() < deadline; ) {
    const ticket = readTicket(id) as Ticket;
    if (ticket.status !== "starting") return ticket;
    if (exited) break;
    await sleep(POLL_MS);
  }
  const ticket = readTicket(id) as Ticket;
  if (ticket.status !== "starting") return ticket;
  // Given up on: its process goes first, or it would hold its port and write the ticket after this.
  const stoppedItself = exited;
  if (!stoppedItself && child.pid !== undefined) await stop(child.pid);
  return update(id, {
    status: "failed",
    message: stoppedItself
      ? `the sign-in stopped before it started: ${ticketLogPath(id)} says why`
      : `the sign-in gave no address to open within ${startTimeoutMs / 1000}s: ${ticketLogPath(id)} says why`,
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
    // The log is where a failed ticket points: the whole error goes there, its message to the ticket.
    console.error(error);
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
