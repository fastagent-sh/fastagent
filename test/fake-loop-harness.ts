/**
 * A `LoopHarness` over an in-memory store, for the protocol suite. What a piece of work does is read from its message:
 * `hold` waits for `release()` (or a stop), `fail` ends with a model error, `effect` runs a side-effecting tool once,
 * `late` is answered at once but its work settles only on `release()`, so a steer sent meanwhile is never taken, and
 * anything else is answered `answer: <text>`. A steered message is taken after the current one, as pi does.
 *
 * `restart()` is a process restart: the store (the disk) stays, a new harness opens it, and the old one's work never
 * move again, the way a killed process's do not.
 */
import type {
  HandedMessage,
  LogRecord,
  LoopHarness,
  LoopHooks,
  LoopLog,
  LoopRun,
  MessageMarker,
} from "../src/loop-port.ts";
import { type Json, type Result, agentError, failure } from "../src/protocol.ts";

interface StoredSession {
  records: LogRecord[];
  leaf?: string;
  name?: string;
  model?: string;
  thinkingLevel?: string;
  createdAt: number;
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

export class FakeStore {
  readonly sessions = new Map<string, StoredSession>();
  generation = 0;
  effects = 0;
  /** How many messages an extension command consumed. */
  handled = 0;
  /** Logs this process has open. */
  openLogs = 0;
  /** Makes the storage refuse the next append of this kind, the way a full disk would. */
  refuseNext: string | undefined;
  private ids = 0;
  private held = gate();

  nextId(): string {
    return `e${++this.ids}`;
  }

  /** Lets every piece of work of the current process that is holding go on. */
  release(): void {
    this.held.open();
    this.held = gate();
  }

  holding(): Promise<void> {
    return this.held.opened;
  }

  restart(): void {
    this.generation++;
    this.openLogs = 0;
    this.held = gate();
  }
}

const MESSAGE_MARKERS: ReadonlySet<string> = new Set<MessageMarker>([
  "message_accepted",
  "message_taken",
  "message_ended",
]);

export function fakeLoopHarness(store: FakeStore): LoopHarness {
  const generation = store.generation;
  const alive = () => {
    if (store.generation !== generation) throw new Error("this process was restarted");
  };

  const logOf = (sessionId: string, stored: StoredSession, onRecord: (record: LogRecord) => void): LoopLog => {
    let closed = false;
    store.openLogs++;
    /** `before` hears the record durable and not yet reported, as a loop says a message's fate (LoopHooks.fate). */
    const write = (kind: string, data: Json, before?: (record: LogRecord) => void): LogRecord => {
      alive();
      if (closed) throw new Error(`the log of ${sessionId} is closed`);
      if (store.refuseNext === kind) {
        store.refuseNext = undefined;
        throw new Error("ENOSPC: no space left on device");
      }
      const record: LogRecord = {
        id: store.nextId(),
        ...(stored.leaf ? { parentEntryId: stored.leaf } : {}),
        timestamp: Date.now(),
        kind,
        data,
      };
      stored.records.push(record);
      stored.leaf = record.id;
      before?.(record);
      onRecord(record);
      return record;
    };

    const run = (first: HandedMessage, { emit, fate }: LoopHooks): LoopRun => {
      const handed: HandedMessage[] = [first];
      let next = 0;
      let finished = false;
      let stopped = false;
      const stop = gate();
      const done = (async () => {
        let outcome: Awaited<LoopRun["done"]>["outcome"] = { status: "completed" };
        while (next < handed.length) {
          const { id, prompt: taken } = handed[next++] as HandedMessage;
          // An extension command: consumed, and nothing written.
          if (taken.text === "handle") {
            store.handled++;
            fate(id, { handled: true });
            continue;
          }
          write("user_message", { text: taken.text }, (record) => fate(id, { taken: record.id }));
          if (taken.text === "hold") await Promise.race([store.holding(), stop.opened]);
          if (stopped) {
            outcome = { status: "failed", error: agentError("internal", "stopped") };
            break;
          }
          if (taken.text === "fail") {
            write("assistant_message", { text: "", error: "boom" });
            outcome = { status: "failed", error: agentError("model_error", "boom") };
            continue;
          }
          if (taken.text === "effect") {
            store.effects++;
            write("tool_result", { toolCallId: "t1", toolName: "effect", isError: false, text: "done" });
          }
          const text = `answer: ${taken.text}`;
          emit({ type: "message_delta", channel: "text", delta: text });
          write("assistant_message", { text });
          outcome = { status: "completed" };
          if (taken.text === "late") {
            finished = true;
            await Promise.race([store.holding(), stop.opened]);
          }
        }
        finished = true;
        return { outcome, usage: { inputTokens: 1, outputTokens: 1 } };
      })();
      return {
        // A message handed after the loop finished is one it never takes, as pi's late `steer()`.
        steer: (steered) => {
          if (!finished) handed.push(steered);
        },
        stop: () => {
          stopped = true;
          stop.open();
        },
        done,
      };
    };

    return {
      records: () => stored.records,
      append: (kind, data) => write(kind, data),
      state: () => ({
        ...(stored.name === undefined ? {} : { name: stored.name }),
        ...(stored.model === undefined ? {} : { model: stored.model }),
        ...(stored.thinkingLevel === undefined ? {} : { thinkingLevel: stored.thinkingLevel }),
        ...(stored.leaf === undefined ? {} : { leafEntryId: stored.leaf }),
      }),
      run,
      rewind: async (entryId): Promise<Result> => {
        stored.leaf = entryId;
        return { ok: true };
      },
      compact: async (): Promise<Result> => {
        const messages = stored.records.filter((r) => r.kind === "user_message" || r.kind === "assistant_message");
        const firstKept = messages.at(-1);
        if (!firstKept) return failure("nothing_to_compact", "nothing to compact");
        write("compaction", { summary: "earlier talk", firstKeptEntryId: firstKept.id });
        return { ok: true };
      },
      update: async (settings): Promise<Result> => {
        Object.assign(stored, settings);
        write("settings_changed", settings);
        return { ok: true };
      },
      attachment: async () => undefined,
      close: () => {
        if (!closed) store.openLogs--;
        closed = true;
      },
    };
  };

  return {
    capabilities: {
      steer: true,
      fork: true,
      rewind: true,
      compaction: true,
      delete: true,
      updatable: ["name", "model", "thinkingLevel"],
      toolProgress: false,
      usage: true,
    },
    open: async (sessionId, onRecord) => {
      alive();
      const stored = store.sessions.get(sessionId);
      return stored ? logOf(sessionId, stored, onRecord) : undefined;
    },
    create: async (sessionId, onRecord, fork) => {
      alive();
      if (store.sessions.has(sessionId)) throw new Error(`session ${sessionId} exists`);
      const stored: StoredSession = { records: [], createdAt: Date.now() };
      if (fork) {
        const source = fork.from.records();
        const end = fork.entryId === undefined ? source.length : source.findIndex((r) => r.id === fork.entryId) + 1;
        // Message records are not copied, so a kept record's parent is its nearest kept ancestor.
        const kept = new Map<string, string | undefined>();
        for (const record of source.slice(0, end)) {
          const parent = record.parentEntryId === undefined ? undefined : kept.get(record.parentEntryId);
          if (MESSAGE_MARKERS.has(record.kind)) {
            kept.set(record.id, parent);
            continue;
          }
          const { parentEntryId: _source, ...rest } = record;
          stored.records.push(parent === undefined ? rest : { ...rest, parentEntryId: parent });
          kept.set(record.id, record.id);
        }
        stored.leaf = stored.records.at(-1)?.id;
      }
      store.sessions.set(sessionId, stored);
      return logOf(sessionId, stored, onRecord);
    },
    delete: async (sessionId) => {
      store.sessions.delete(sessionId);
    },
    list: async () =>
      [...store.sessions].map(([sessionId, stored]) => ({
        sessionId,
        status: "idle" as const,
        createdAt: stored.createdAt,
        updatedAt: stored.records.at(-1)?.timestamp ?? stored.createdAt,
      })),
    models: async () => [],
    commands: async () => [],
  };
}
