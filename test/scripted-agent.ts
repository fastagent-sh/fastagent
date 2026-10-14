/**
 * A SPEC v1 Agent whose runs a test scripts: `invoke` streams what the script yields for each request. The rest of
 * the Agent is what a channel asks of it, kept just faithful enough to observe:
 *   - each run the script ends is recorded under its session, with its key and answer, so `read` and `runs.get`
 *     answer for it (a thread forks from a room by the run its reply chain names);
 *   - `sessions.create` records each fork it is asked for (`forks`);
 *   - `abort` records the session (`aborted`) and answers what `stopped` says, nothing running by default.
 */
import type {
  AbortResult,
  Agent,
  Entry,
  ForkSource,
  InvokeEvent,
  InvokeRequest,
  RunOutcome,
  RunStatus,
  Session,
} from "../src/protocol.ts";
import { failure } from "../src/protocol.ts";
import { runText } from "../src/run-text.ts";

export type Script = (request: InvokeRequest) => AsyncIterable<InvokeEvent> | Iterable<InvokeEvent>;

export interface ScriptedAgent extends Agent {
  /** Every `sessions.create`, in order. */
  forks: { sessionId?: string; fork?: ForkSource }[];
  /** Every session `abort` was called for, in order. */
  aborted: string[];
}

interface Kept {
  entries: Entry[];
  runs: RunStatus[];
}

export function scriptedAgent(script: Script, options: { stopped?: (sessionId: string) => AbortResult } = {}) {
  const sessions = new Map<string, Kept>();
  const forks: ScriptedAgent["forks"] = [];
  const aborted: string[] = [];
  let entries = 0;

  /** Keep a run the script ended: its message and answer as entries, and the run, findable by its key. */
  const keep = (request: InvokeRequest, sessionId: string, runId: string, outcome: RunOutcome, answer: string) => {
    const kept = sessions.get(sessionId) ?? { entries: [], runs: [] };
    sessions.set(sessionId, kept);
    const append = (kind: string, text: string): Entry => {
      const parentEntryId = kept.entries.at(-1)?.id;
      const entry: Entry = {
        id: `e${++entries}`,
        timestamp: Date.now(),
        runId,
        kind,
        data: { text },
        ...(parentEntryId ? { parentEntryId } : {}),
      };
      kept.entries.push(entry);
      return entry;
    };
    const message = append("user_message", request.prompt.text);
    const answered = answer === "" ? undefined : append("assistant_message", answer);
    kept.runs.push({
      runId,
      ...(request.source ? { source: request.source } : {}),
      messages: [
        { entryId: message.id, ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}) },
      ],
      status: "done",
      endedAt: Date.now(),
      outcome,
      ...(answered ? { answer: { entryId: answered.id, text: answer } } : {}),
    });
  };

  const session = (sessionId: string): Session => ({
    sessionId,
    read: async () => {
      const kept = sessions.get(sessionId);
      if (!kept) return failure("not_found", `no session ${sessionId}`);
      const leafEntryId = kept.entries.at(-1)?.id;
      return {
        ok: true,
        state: { status: "idle", queued: [], ...(leafEntryId ? { leafEntryId } : {}) },
        entries: kept.entries,
      };
    },
    follow: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    attachment: async () => undefined,
    abort: async () => {
      aborted.push(sessionId);
      return options.stopped?.(sessionId) ?? { ok: true, stopped: { queued: [], compaction: false } };
    },
    rewind: async () => failure("unsupported", "not in this double"),
    compact: async () => failure("unsupported", "not in this double"),
    update: async () => failure("unsupported", "not in this double"),
    delete: async () => failure("unsupported", "not in this double"),
    runs: {
      get: async (key) =>
        sessions
          .get(sessionId)
          ?.runs.find((run) =>
            "runId" in key
              ? run.runId === key.runId
              : run.messages.some((message) => message.idempotencyKey === key.idempotencyKey),
          ),
      follow: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      cancel: async () => ({ ok: true }),
    },
  });

  const agent: ScriptedAgent = {
    invoke: (request) => ({
      async *[Symbol.asyncIterator]() {
        let runId: string | undefined;
        let sessionId = request.sessionId ?? "";
        let answer = "";
        const textOf = runText(() => runId);
        for await (const event of script(request)) {
          if (event.type === "accepted") {
            runId = event.run.runId;
            sessionId = request.sessionId ?? event.sessionId;
          }
          if (event.type === "message_delta" || event.type === "entry") answer += textOf(event);
          if (
            runId !== undefined &&
            event.type === "entry" &&
            event.entry.kind === "run_ended" &&
            event.entry.runId === runId
          ) {
            keep(request, sessionId, runId, (event.entry.data as { outcome: RunOutcome }).outcome, answer);
          }
          yield event;
        }
      },
    }),
    sessions: {
      create: async (options = {}) => {
        forks.push(options);
        return { ok: true, sessionId: options.sessionId ?? `session-${forks.length}` };
      },
      list: async () => [],
      get: session,
    },
    info: () => ({
      protocolVersion: "1.0",
      capabilities: {
        steer: false,
        fork: true,
        rewind: false,
        compaction: false,
        delete: false,
        updatable: [],
        durableQueue: false,
        durableRuns: false,
        toolProgress: true,
        usage: false,
      },
    }),
    models: async () => [],
    commands: async () => [],
    forks,
    aborted,
  };
  return agent;
}

/** What a stop answers when it stopped a run. */
export const stoppedRun: AbortResult = { ok: true, stopped: { runId: "run", queued: [], compaction: false } };

/** `agent` with its sessions' `abort` answering `stopped`, each session it is called for recorded in `aborted`. */
export function withStop(agent: Agent, stopped: (sessionId: string) => AbortResult): Agent & { aborted: string[] } {
  const aborted: string[] = [];
  return {
    ...agent,
    sessions: {
      ...agent.sessions,
      get: (sessionId) => ({
        ...agent.sessions.get(sessionId),
        abort: async () => {
          aborted.push(sessionId);
          return stopped(sessionId);
        },
      }),
    },
    aborted,
  };
}
