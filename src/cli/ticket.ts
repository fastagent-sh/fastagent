/**
 * A step a coding agent starts and a person finishes: an account sign-in, a new app's confirmation, an app's install.
 * A coding agent works in turns: it runs a command, reads what it printed once it ends, then talks to its user. So the
 * step outlives the command that starts it, as Netlify's `login --request`/`--check` and Dosu's login tickets have it:
 * the command starts a process of its own that runs the step and keeps a ticket up to date, and returns as soon as
 * there is something for the person to do. The command's `--check <ticket>` reads where it stands from any process,
 * and hands the step the address a browser ended on when that browser could not reach this machine.
 *
 * A ticket is two files in the machine's own state, ~/.fastagent/.state/tickets. One is the step as its process keeps
 * it, written by one process at a time: the starting command until the step starts, then the step. The other is its
 * end, written once, by whoever ends it first: the step itself, or a process that stops it, replaces it or finds it
 * gone. An end is decided before what it decides is done, so a stop is the end of the step it stops even when the step
 * hears the consequences of being stopped first, and nothing the step writes after reopens it. A newer step for the same subject stops an older one still waiting on its person, whose
 * process would otherwise hold what it holds (a sign-in's callback port, OpenAI's fixed) until it expires; so does one
 * still getting ready (reaching a box, opening a tunnel), which may hang there. One finishing what its person did (a
 * code exchanged, an app created from a pasted token) is never stopped halfway, and the newer attempt is answered
 * with it.
 *
 * The step's process leads a process group of its own, so what it starts (a tunnel, a host CLI, a shell to a box) is
 * stopped with it, by `stop` and when it exits.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { writeFileAtomic } from "../atomic-write.ts";
import { STATE_DIRNAME, globalHome } from "../paths.ts";
import { recordFailures } from "./fail.ts";
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
  /** When the person's step itself stops being usable (a confirmation link's own expiry), if before `expiresAt`. */
  until?: number;
  /** The person's part is done and the step is finishing it: never stopped halfway. */
  finishing?: boolean;
  /** What every report of the ticket carries beside its status (the provider a sign-in is to, the deployment). */
  fields?: Record<string, string>;
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
const DAY_MS = 24 * 60 * 60 * 1000;
/** Ticket files are random hex: anything else names no ticket, and no file outside the directory. */
const TICKET_ID = /^[0-9a-f]{16}$/;

const ticketsDir = () => join(globalHome(), STATE_DIRNAME, "tickets");
const ticketPath = (id: string) => join(ticketsDir(), `${id}.json`);
const addressPath = (id: string) => join(ticketsDir(), `${id}.address`);
/** What the step's process says while it runs: the place to look when it fails. */
export const ticketLogPath = (id: string) => join(ticketsDir(), `${id}.log`);

const endPath = (id: string) => join(ticketsDir(), `${id}.end.json`);

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The ticket `id`: the step as its process keeps it, with its end over it once it has one. */
function readTicket(id: string): Ticket | undefined {
  if (!TICKET_ID.test(id)) return undefined;
  const kept = readJson<Ticket>(ticketPath(id));
  if (kept === undefined) return undefined;
  const end = readJson<Partial<Ticket>>(endPath(id));
  return end === undefined ? kept : { ...kept, ...end };
}

/** The step as its process keeps it: one writer at a time, the starting command and then the step. */
const writeTicket = (ticket: Ticket): void => writeFileAtomic(ticketPath(ticket.ticket), JSON.stringify(ticket));

const waiting = (ticket: Ticket) =>
  ticket.status === "starting" || ticket.status === "need_user_action" || ticket.status === "working";

const ENDS: readonly TicketStatus[] = ["done", "failed", "expired"];

/**
 * End the ticket `id` with `end`, unless something ended it first: the end is a file created once, by a hard link,
 * which the kernel lets only one writer make, so two that both read the ticket as running (the step finishing as a
 * person stops it) end it once. Answers the ticket as whoever ended it ended it. Not public: `update` ends a ticket,
 * and a test seam.
 */
export function endTicket(id: string, end: Partial<Ticket>): Ticket {
  const draft = `${endPath(id)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(draft, JSON.stringify(end));
  try {
    linkSync(draft, endPath(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(draft, { force: true });
  }
  return readTicket(id) as Ticket;
}

/**
 * Change the ticket `id` while its step still runs; one that has ended is returned as it ended. An end is
 * `endTicket`'s, so the first one written is the one that stays; anything else is the step's own record, which its
 * process alone writes.
 */
function update(id: string, change: Partial<Ticket>): Ticket {
  const current = readTicket(id);
  if (current === undefined) throw new Error(`ticket ${id} is gone from ${ticketsDir()}`);
  if (!waiting(current)) return current;
  if (change.status !== undefined && ENDS.includes(change.status)) return endTicket(id, change);
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
    // One finishing past its deadline still runs: the deadline is for the person, never for work begun.
    const current = ticket !== undefined && (ticket.expiresAt >= now || ticket.finishing === true);
    const runs = ticket?.subject === subject && waiting(ticket) && current && running(ticket.pid);
    return runs ? [ticket as Ticket] : [];
  });
}

/**
 * Before a newer step for `subject` starts: one finishing what its person did is the answer instead, never stopped
 * halfway (an app created whose credentials are not written yet); every other one, waiting on its person or still
 * getting ready, is stopped. Answers the one finishing.
 */
async function supersede(subject: string, now: number): Promise<Ticket | undefined> {
  const runs = runningFor(subject, now);
  const finishing = runs.find((ticket) => ticket.finishing === true);
  if (finishing !== undefined) return finishing;
  for (const ticket of runs) {
    update(ticket.ticket, { status: "failed", message: `replaced by a newer attempt to ${ticket.action}` });
    if (ticket.pid !== undefined) await stop(ticket.pid);
  }
  return undefined;
}

/** Tickets a day past their end: every file of each one goes. */
function prune(now: number): void {
  if (!existsSync(ticketsDir())) return;
  const files = readdirSync(ticketsDir());
  const past = new Set(
    files
      .map((file) => file.slice(0, 16))
      .filter((id) => TICKET_ID.test(id) && (readTicket(id)?.expiresAt ?? Number.POSITIVE_INFINITY) < now - DAY_MS),
  );
  for (const file of files) if (past.has(file.slice(0, 16))) rmSync(join(ticketsDir(), file), { force: true });
}

export interface TicketRequest {
  subject: string;
  action: string;
  check: string;
  restart: string;
  timeoutSeconds: number;
  /** {@link Ticket.fields}. */
  fields?: Record<string, string>;
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
    ...(request.fields === undefined ? {} : { fields: request.fields }),
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
    /**
     * A step for the same subject still running: `replace` stops one waiting on its person or still getting ready (a
     * sign-in, holding a port the new one needs) and answers with one finishing what its person did; `join` answers
     * with it whatever it is doing (a deploy, which must not be stopped halfway, even between its person's steps).
     */
    whenRunning: "replace" | "join";
    /** How long the step may take to give the person something to do; a test's is short. */
    startTimeoutMs?: number;
  },
): Promise<Ticket> {
  if (input.whenRunning === "join") {
    const [joined] = runningFor(input.subject, Date.now());
    if (joined !== undefined) return joined;
  } else {
    const finishing = await supersede(input.subject, Date.now());
    if (finishing !== undefined) return finishing;
  }
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
  // Claimed and at work: the step writes the ticket now, so this command reports it as it is.
  if (!exited && !input.waitsFirst && ticket.status === "working") return ticket;
  // Given up on, unclaimed or giving the person nothing: the end first, then its process, which would hold its port.
  const stoppedItself = exited;
  const within = `${startTimeoutMs / 1000}s: ${ticketLogPath(id)} says why`;
  const ended = update(id, {
    status: "failed",
    message: stoppedItself
      ? `it stopped before it started: ${ticketLogPath(id)} says why`
      : ticket.status === "starting"
        ? `it did not start within ${within}`
        : `it gave the person nothing to do within ${within}`,
  });
  if (!stoppedItself && child.pid !== undefined) await stop(child.pid);
  return ended;
}

/**
 * Where the step `id` stands. `address`: what the person's browser ended on (or the code its page showed), for a step
 * waiting on one; it is handed over, and the answer is the ticket once the step has taken it.
 */
export async function checkTicket(id: string, address?: string): Promise<Ticket | undefined> {
  let ticket = readTicket(id);
  if (ticket === undefined) return undefined;
  if (address !== undefined && ticket.status === "need_user_action") {
    writeFileAtomic(addressPath(id), address, undefined, true);
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
 * Stop the step of ticket `id` where it is, and everything it started, on a person's or an agent's say: the way out of
 * a step that hangs while finishing, which no deadline cuts. What it was doing may be left half-done.
 */
export async function stopTicket(id: string): Promise<Ticket> {
  const ticket = readTicket(id);
  if (ticket === undefined) throw new Error(`ticket ${id} is gone from ${ticketsDir()}`);
  if (!waiting(ticket)) return ticket;
  const ended = update(id, {
    status: "failed",
    message: `stopped on request; what it was doing may be left half-done (${ticketLogPath(id)} says where it was)`,
  });
  if (ticket.pid !== undefined) await stop(ticket.pid);
  return ended;
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
  waits(on: { url: string; code?: string; instructions?: string; takesAddress?: boolean; until?: number }): void;
  /** The address `--check --code` hands over, once it does. */
  address(signal: AbortSignal): Promise<string>;
}

/**
 * The step of ticket `id`, in the process `startTicket` started: `run` does it, through what it is handed, and
 * resolves with what to report once done. Whatever it throws fails the ticket, the whole error going to the log. At
 * the deadline the ticket expires, whether or not `run` heeds the signal (the caller ends the process after this, and
 * a run still going ends with it), unless the step is finishing what its person did: that runs to its end, and
 * expires only if it waits on its person again.
 */
export async function runTicket(
  id: string,
  run: (step: TicketStep) => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  const ticket = readTicket(id);
  if (ticket === undefined) throw new Error(`no ticket ${id} in ${ticketsDir()}`);
  const claimed = update(id, { pid: process.pid, status: "working" });
  if (claimed.status !== "working" || claimed.pid !== process.pid) {
    // Given up on before this process got to it (a start slower than the start window): not ours to run.
    console.error(`[fastagent] ticket ${id} ended (${claimed.status}) before this process took it; not running it`);
    return;
  }
  recordFailures((message) => update(id, { status: "failed", message }));
  // However this process ends (done, failed, expired with the run still waiting), what it started goes with it.
  if (leadsGroup()) process.once("exit", () => signalGroup(process.pid, "SIGTERM"));
  // The deadline bounds what the step waits on (its person, getting ready), never what it is finishing (a host's
  // deploy, a code exchanged): past it, a step finishing is let finish, and expires the moment it would wait again.
  const expiry = new AbortController();
  let finishing = false;
  const expireIfDue = (): void => {
    if (!finishing && !expiry.signal.aborted && Date.now() >= ticket.expiresAt) expiry.abort(new Error("expired"));
  };
  const clock = setInterval(expireIfDue, POLL_MS);
  const signal = expiry.signal;
  // Each step replaces the last one's fields: a code or an expiry of the one before is not this one's.
  const waits: TicketStep["waits"] = (on) => {
    finishing = false;
    update(id, {
      status: "need_user_action",
      code: undefined,
      instructions: undefined,
      takesAddress: undefined,
      until: undefined,
      finishing: undefined,
      ...on,
    });
  };
  const afterwards: Person["afterwards"] = (instructions, url) => {
    const current = readTicket(id);
    update(id, {
      afterwards: [...(current?.afterwards ?? []), { instructions, ...(url === undefined ? {} : { url }) }],
    });
  };
  const step: TicketStep = {
    signal,
    person: {
      waitsOn: (url, instructions, until) => waits({ url, instructions, ...(until === undefined ? {} : { until }) }),
      carriesOn: () => {
        finishing = true;
        update(id, { status: "working", finishing: true });
      },
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
  } finally {
    clearInterval(clock);
    recordFailures(undefined);
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

const LOG_TAIL_LINES = 12;
const LOG_TAIL_BYTES = 8192;
const LOG_LINE_CHARS = 300;

/**
 * The last lines of a ticket's log, without terminal colors: where a failed step says why. A coding agent reads a
 * report once, and "see the output above" points at a log it has not opened.
 */
function logTail(id: string): string[] {
  const path = ticketLogPath(id);
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return stripVTControlCharacters(buffer.toString("utf8"))
      .split("\n")
      .map((line) => line.trim().slice(0, LOG_LINE_CHARS))
      .filter((line) => line !== "")
      .slice(-LOG_TAIL_LINES);
  } finally {
    closeSync(fd);
  }
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
  const base = { ...ticket.fields, status: ticket.status, ticket: ticket.ticket };
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
  const log = ticketLogPath(ticket.ticket);
  if (ticket.status === "failed" || ticket.status === "expired") {
    const message = ticket.status === "expired" ? "it was not finished in time" : (ticket.message as string);
    // What the step reached before it ended is still the person's: where to get the value it stopped for, say.
    const reached = left.length === 0 ? "" : `Tell the user what the steps it reached leave them: ${left.join(" ")} `;
    // An expired step is not a fault: nobody finished it in time, and its log says nothing more.
    const expired = ticket.status === "expired";
    const tail = expired ? [] : logTail(ticket.ticket);
    return {
      json: {
        ...base,
        message,
        log,
        ...(tail.length === 0 ? {} : { log_tail: tail }),
        ...(ticket.afterwards ? { afterwards: ticket.afterwards } : {}),
        agent_next_steps: expired
          ? `${reached}The step was not finished in time, which is not a fault: ask the user to complete it as soon ` +
            `as you run: ${ticket.restart} --json`
          : `${reached}The cause is in log_tail (the whole log is at log): fix what it names, then run: ` +
            `${ticket.restart} --json. The same inputs fail the same way unless the log shows a transient network or ` +
            `builder error.`,
      },
      text: [
        `${ticket.status}: ${message}`,
        `log: ${log}`,
        ...tail.map((line) => `  | ${line}`),
        ...left.map((line) => `left for the person: ${line}`),
        `to try again: ${ticket.restart}`,
      ],
    };
  }
  if (ticket.status === "starting" || ticket.status === "working") {
    return {
      json: {
        ...base,
        check_command: `${check} --json`,
        log,
        agent_next_steps:
          "fastagent is working on it, with nothing for the user to do now. Run check_command again in a minute.",
      },
      text: [`${ticket.status}: nothing for the person to do now`, `log: ${log}`, `then run: ${check}`],
    };
  }
  const resume = `${check} --code '<address>'`;
  const give =
    ticket.code === undefined
      ? `Give the URL to the user so they can ${ticket.action}.`
      : `Give the URL and the code ${ticket.code} to the user so they can ${ticket.action} there.`;
  const then = ticket.takesAddress
    ? "Once they say they have, run check_command. If their browser ends on a page that does not load (an address " +
      "on localhost), or on one showing a one-time code to hand back, ask them for that address or code and run " +
      "resume_command with it in place of <address>."
    : "Once they say they have, run check_command.";
  return {
    json: {
      ...base,
      ...(ticket.url === undefined ? {} : { url: ticket.url }),
      ...(ticket.code === undefined ? {} : { code: ticket.code }),
      ...(ticket.instructions === undefined ? {} : { instructions: ticket.instructions }),
      // The person's step can lapse before the ticket does (a confirmation link of the platform's own).
      expires_in: Math.max(0, Math.round((Math.min(ticket.expiresAt, ticket.until ?? Infinity) - Date.now()) / 1000)),
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
