/**
 * A step a coding agent starts and a person finishes: an account sign-in, a new app's confirmation, an app's install.
 * A coding agent works in turns: it runs a command, reads what it printed once it ends, then talks to its user. So the
 * step outlives the command that starts it, as Netlify's `login --request`/`--check` and Dosu's login tickets have it:
 * the command starts a process of its own that runs the step and keeps a ticket up to date, and returns as soon as
 * there is something for the person to do. The command's `--check <ticket>` reads where it stands from any process,
 * and hands the step the address a browser ended on when that browser could not reach this machine.
 *
 * A ticket is a file in the machine's own state, ~/.fastagent/.state/tickets, written whole by one process at a time:
 * the starting command until the step starts, then the step alone (or whoever finds its process gone). One that has
 * ended stays as it ended. A newer step for the same subject stops an older one still waiting on its person, whose
 * process would otherwise hold what it holds (a sign-in's callback port, OpenAI's fixed) until it expires; one at work
 * is never stopped halfway, and the newer attempt is answered with it.
 *
 * The step's process leads a process group of its own, so what it starts (a tunnel, a host CLI, a shell to a box) is
 * stopped with it, by `stop` and when it exits.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { STATE_DIRNAME, globalHome } from "../paths.ts";
import type { Person } from "./person.ts";

type TicketStatus = "starting" | "need_user_action" | "working" | "done" | "failed" | "expired";

export interface Ticket {
  ticket: string;
  /** What the step is for, one per subject at a time: `login:openai`, `add:feishu:production`. */
  subject: string;
  /** What the person does, to follow "so they can": `sign in to OpenAI`, `confirm the new Feishu app`. */
  action: string;
  /** The command that reads the ticket, its id appended: `fastagent login --check`. */
  check: string;
  /** The command that starts the step again. */
  restart: string;
  status: TicketStatus;
  /** When the step gives up (ms since the epoch). */
  expiresAt: number;
  /** The process running the step. */
  pid?: number;
  /** Where the person acts. */
  url?: string;
  /** What they enter there, for a device sign-in. */
  code?: string;
  /** What the provider or platform says to do there. */
  instructions?: string;
  /** The step's browser may end on a page this machine never sees, whose address `--check --code` hands over. */
  takesAddress?: boolean;
  /** Steps left to the person after the run, which nothing waits for. */
  afterwards?: { instructions: string; url?: string }[];
  /** Why the step failed. */
  message?: string;
  /** What the step reports when done, in fields of its own (a credentials path, the values it wrote). */
  result?: Record<string, unknown>;
}

/** How long a starting step may take to give the person something to do before its command gives up on it. */
const START_TIMEOUT_MS = 30_000;
/** How long `--check` waits for a step to take the address it was handed. */
const ADDRESS_TIMEOUT_MS = 15_000;
/** How long a stopped step's process has to let go of what it holds before it is killed. */
const STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 200;
/** Ticket files are random hex: anything else names no ticket, and no file outside the directory. */
const TICKET_ID = /^[0-9a-f]{16}$/;

const ticketsDir = () => join(globalHome(), STATE_DIRNAME, "tickets");
const ticketPath = (id: string) => join(ticketsDir(), `${id}.json`);
const addressPath = (id: string) => join(ticketsDir(), `${id}.address`);
/** What the step's process says while it runs: the place to look when it fails. */
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

const waiting = (ticket: Ticket) =>
  ticket.status === "starting" || ticket.status === "need_user_action" || ticket.status === "working";

/**
 * Change the ticket `id` while its step still runs; one that has ended is returned as it ended. A writer that read it
 * before it ended (a check that found its process gone the moment it finished) cannot reopen it.
 */
function update(id: string, change: Partial<Ticket>): Ticket {
  const current = readTicket(id);
  if (current === undefined) throw new Error(`ticket ${id} is gone from ${ticketsDir()}`);
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

/**
 * Signal the process group `pid` leads. A group gone has nothing left to stop (ESRCH), and one this user may not
 * signal is not ours (EPERM, which macOS also answers for a group of one exited, unreaped process).
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

/** Stop a step's process and everything it started, and wait until it is gone, so what it held is free. */
async function stop(pid: number): Promise<void> {
  if (!running(pid)) return;
  signalGroup(pid, "SIGTERM");
  for (const deadline = Date.now() + STOP_TIMEOUT_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    if (!running(pid)) break;
  }
  // What the step started may outlive it, or ignore SIGTERM.
  signalGroup(pid, "SIGKILL");
}

/** Whether this process leads a process group: a step's process, which `startTicket` starts detached. */
function leadsGroup(): boolean {
  try {
    process.kill(-process.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The steps for `subject` still running. Only an unexpired one is taken for a process of ours: its pid is minutes old,
 * where one an ended process left could by now name another's.
 */
function runningFor(subject: string, now: number): Ticket[] {
  if (!existsSync(ticketsDir())) return [];
  return readdirSync(ticketsDir()).flatMap((file) => {
    const ticket = file.endsWith(".json") ? readTicket(file.slice(0, -".json".length)) : undefined;
    const runs = ticket?.subject === subject && waiting(ticket) && ticket.expiresAt >= now && running(ticket.pid);
    return runs ? [ticket as Ticket] : [];
  });
}

/**
 * Before a newer step for `subject` starts: one at work is the answer instead, never stopped halfway (an app created
 * whose credentials are not written yet); every one waiting on its person is stopped. Answers the one at work.
 */
async function supersede(subject: string, now: number): Promise<Ticket | undefined> {
  const runs = runningFor(subject, now);
  const atWork = runs.find((ticket) => ticket.status === "working");
  if (atWork !== undefined) return atWork;
  for (const ticket of runs) {
    if (ticket.pid !== undefined) await stop(ticket.pid);
    update(ticket.ticket, { status: "failed", message: `replaced by a newer attempt to ${ticket.action}` });
  }
  return undefined;
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

export interface TicketRequest {
  subject: string;
  action: string;
  check: string;
  restart: string;
  timeoutSeconds: number;
}

/** A new ticket, its step not started yet. Not public: what `startTicket` starts, and a test seam. */
export function createTicket(request: TicketRequest): Ticket {
  const now = Date.now();
  prune(now);
  mkdirSync(ticketsDir(), { recursive: true });
  const ticket: Ticket = {
    ticket: randomBytes(8).toString("hex"),
    subject: request.subject,
    action: request.action,
    check: request.check,
    restart: request.restart,
    status: "starting",
    expiresAt: now + request.timeoutSeconds * 1000,
  };
  writeTicket(ticket);
  return ticket;
}

/**
 * Start a step in a process of its own and return its ticket once the person has something to do, or it has ended.
 */
export async function startTicket(
  input: TicketRequest & {
    /** The command that runs the step, its arguments, and the directory it runs in; `--ticket <id>` is added. */
    command: { file: string; args: readonly string[]; cwd: string };
    /**
     * true: the person's part comes first (a sign-in's address), and a step that gives none within the start timeout
     * is stopped. false: the step may work a while first (a tunnel, a verification), or need no one at all, and one
     * still at it then is returned working, its process carrying on.
     */
    waitsFirst: boolean;
    /** How long the step may take to give the person something to do; a test's is short. */
    startTimeoutMs?: number;
  },
): Promise<Ticket> {
  const atWork = await supersede(input.subject, Date.now());
  if (atWork !== undefined) return atWork;
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
  const settled = (ticket: Ticket) => ticket.status !== "starting" && ticket.status !== "working";
  for (const deadline = Date.now() + startTimeoutMs; Date.now() < deadline; ) {
    const ticket = readTicket(id) as Ticket;
    if (settled(ticket)) return ticket;
    if (exited) break;
    await sleep(POLL_MS);
  }
  const ticket = readTicket(id) as Ticket;
  if (settled(ticket)) return ticket;
  // Still at it: the step writes the ticket now, so this command reports it as it is.
  if (!exited && !input.waitsFirst) return ticket;
  // Given up on: its process goes first, or it would hold its port and write the ticket after this.
  const stoppedItself = exited;
  if (!stoppedItself && child.pid !== undefined) await stop(child.pid);
  return update(id, {
    status: "failed",
    message: stoppedItself
      ? `it stopped before it started: ${ticketLogPath(id)} says why`
      : `it gave the person nothing to do within ${startTimeoutMs / 1000}s: ${ticketLogPath(id)} says why`,
  });
}

/**
 * Where the step `id` stands. `address`: what the person's browser ended on (or the code its page showed), for a step
 * waiting on one; it is handed over, and the answer is the ticket once the step has taken it.
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
  if (waiting(ticket) && !running(ticket.pid)) {
    return Date.now() > ticket.expiresAt
      ? update(id, { status: "expired" })
      : update(id, { status: "failed", message: `it stopped: ${ticketLogPath(id)} says why` });
  }
  return ticket;
}

/**
 * Why the command whose `--check` is `check` cannot read ticket `id`: there is none on this machine, or it is another
 * command's, named so the agent runs that one. Undefined when it is this command's.
 */
export function refusedCheck(id: string, check: string): string | undefined {
  const ticket = readTicket(id);
  if (ticket === undefined)
    return `no ticket "${id}" on this machine: a ticket is what the command that started it printed`;
  if (ticket.check === check) return undefined;
  return `ticket ${id} is not this command's: it is to ${ticket.action}; check it with \`${ticket.check} ${id}\``;
}

/** What a step's run is handed: the person's part as it comes, and the address `--check --code` brings. */
export interface TicketStep {
  /** When the step gives up. */
  signal: AbortSignal;
  /** The person, as the run speaks to them (person.ts): what it waits on, what it leaves them. */
  person: Person;
  /** The person's step the run now waits on, with what a sign-in's flow says of it. */
  waits(on: { url: string; code?: string; instructions?: string; takesAddress?: boolean }): void;
  /** The address `--check --code` hands over, once it does. */
  address(signal: AbortSignal): Promise<string>;
}

/**
 * The step of ticket `id`, in the process `startTicket` started: `run` does it, through what it is handed, and
 * resolves with what to report once done. Whatever it throws fails the ticket, the whole error going to the log. At
 * the deadline the ticket expires, whether or not `run` heeds the signal; the caller ends the process after this, and
 * a run still going ends with it.
 */
export async function runTicket(
  id: string,
  run: (step: TicketStep) => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  const ticket = readTicket(id);
  if (ticket === undefined) throw new Error(`no ticket ${id} in ${ticketsDir()}`);
  update(id, { pid: process.pid, status: "working" });
  // However this process ends (done, failed, expired with the run still waiting), what it started goes with it.
  if (leadsGroup()) process.once("exit", () => signalGroup(process.pid, "SIGTERM"));
  const signal = AbortSignal.timeout(Math.max(0, ticket.expiresAt - Date.now()));
  const waits: TicketStep["waits"] = (on) => update(id, { status: "need_user_action", ...on });
  const afterwards: Person["afterwards"] = (instructions, url) => {
    const current = readTicket(id);
    update(id, {
      afterwards: [...(current?.afterwards ?? []), { instructions, ...(url === undefined ? {} : { url }) }],
    });
  };
  const step: TicketStep = {
    signal,
    person: {
      waitsOn: (url, instructions) => waits({ url, instructions }),
      carriesOn: () => update(id, { status: "working" }),
      afterwards,
    },
    waits,
    address: (abort) => awaitAddress(id, abort),
  };
  const deadline = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    const result = await Promise.race([run(step), deadline]);
    update(id, { status: "done", ...(result === undefined ? {} : { result }) });
  } catch (error) {
    // The log is where a failed ticket points: the whole error goes there, its message to the ticket.
    console.error(error);
    if (signal.aborted) update(id, { status: "expired" });
    else update(id, { status: "failed", message: (error as Error).message });
  }
}

/** The address `--check --code` hands over, once it does. */
async function awaitAddress(id: string, signal: AbortSignal): Promise<string> {
  while (!signal.aborted) {
    if (existsSync(addressPath(id))) {
      const address = readFileSync(addressPath(id), "utf8");
      rmSync(addressPath(id), { force: true });
      return address;
    }
    await sleep(POLL_MS);
  }
  throw new Error("the step no longer waits for an address");
}

/**
 * A ticket as its command reports it, with what to do next (`agent_next_steps`): one JSON object, or its lines for a
 * person. `done` is what the step's `result` adds to the report, beside a sentence for the agent.
 */
export function ticketReport(
  ticket: Ticket,
  when: "started" | "checked",
  done: (result: Record<string, unknown>) => { fields: Record<string, unknown>; text: string[]; next?: string } = (
    result,
  ) => ({ fields: result, text: [] }),
): { json: Record<string, unknown>; text: string[] } {
  const base = { status: ticket.status, ticket: ticket.ticket };
  const check = `${ticket.check} ${ticket.ticket}`;
  const left = (ticket.afterwards ?? []).map((step) =>
    step.url === undefined ? step.instructions : `${step.instructions} ${step.url}`,
  );
  if (ticket.status === "done") {
    const report = done(ticket.result ?? {});
    const tell = left.length === 0 ? "" : ` Tell the user what is left for them: ${left.join(" ")}`;
    const next = `${report.next ?? "Done."}${tell}`;
    return {
      json: {
        ...base,
        ...report.fields,
        ...(ticket.afterwards ? { afterwards: ticket.afterwards } : {}),
        agent_next_steps: next,
      },
      text: [`done: ${ticket.action}`, ...report.text, ...left.map((line) => `afterwards: ${line}`)],
    };
  }
  if (ticket.status === "failed" || ticket.status === "expired") {
    const message = ticket.status === "expired" ? "it was not finished in time" : (ticket.message as string);
    return {
      json: { ...base, message, agent_next_steps: `To try again, run: ${ticket.restart} --json` },
      text: [`${ticket.status}: ${message}`, `to try again: ${ticket.restart}`],
    };
  }
  if (ticket.status === "starting" || ticket.status === "working") {
    return {
      json: {
        ...base,
        check_command: `${check} --json`,
        agent_next_steps:
          "fastagent is working on it, with nothing for the user to do now. Run check_command again in a minute.",
      },
      text: [`${ticket.status}: nothing for the person to do now`, `then run: ${check}`],
    };
  }
  const resume = `${check} --code '<address>'`;
  const give =
    ticket.code === undefined
      ? `Give the URL to the user so they can ${ticket.action}.`
      : `Give the URL and the code ${ticket.code} to the user so they can ${ticket.action} there.`;
  const then = ticket.takesAddress
    ? "Once they say they have, run check_command. If their browser ends on a page that does not load (an address " +
      "on localhost), ask them for that address and run resume_command with it in place of <address>."
    : "Once they say they have, run check_command.";
  return {
    json: {
      ...base,
      ...(ticket.url === undefined ? {} : { url: ticket.url }),
      ...(ticket.code === undefined ? {} : { code: ticket.code }),
      ...(ticket.instructions === undefined ? {} : { instructions: ticket.instructions }),
      expires_in: Math.max(0, Math.round((ticket.expiresAt - Date.now()) / 1000)),
      check_command: `${check} --json`,
      ...(ticket.takesAddress ? { resume_command: `${resume} --json` } : {}),
      agent_next_steps: when === "started" ? `${give} ${then}` : `The user has not finished yet. ${give} ${then}`,
    },
    text: [
      `need_user_action: ${ticket.action} at`,
      `  ${ticket.url ?? "(no address yet)"}${ticket.code === undefined ? "" : `  (code: ${ticket.code})`}`,
      `then run: ${check}`,
      ...(ticket.takesAddress ? [`if the browser ends on a page that does not load, run: ${resume}`] : []),
    ],
  };
}

/** Print one outcome on stdout, the result it is: the JSON object with `--json`, else its lines for a person. */
export function printReport(asJson: boolean | undefined, json: Record<string, unknown>, text: readonly string[]): void {
  console.log(asJson ? JSON.stringify(json, null, 2) : text.join("\n"));
}

/** The exit code a ticket's command ends with: 1 once it failed or expired, 0 while it runs or once done. */
export const ticketExitCode = (ticket: Ticket) => (ticket.status === "failed" || ticket.status === "expired" ? 1 : 0);
