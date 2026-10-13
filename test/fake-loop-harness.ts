/**
 * A `LoopHarness` over an in-memory store, for the protocol suite. What a run does is read from its message:
 * `hold` waits for `release()` (or a stop), `fail` ends with a model error, `effect` runs a side-effecting tool once,
 * anything else is answered `answer: <text>`. A steered message is taken after the current one, as pi does.
 *
 * `restart()` is a process restart: the store (the disk) stays, a new harness opens it, and the old one's runs never
 * move again, the way a killed process's do not.
 */
import type { LogRecord, LoopHarness, LoopLog, LoopRun, RunMarker } from "../src/loop-port.ts";
import { type Json, type Prompt, type Result, agentError, failure } from "../src/protocol.ts";

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
  /** Makes the storage refuse the next append of this kind, the way a full disk would. */
  refuseNext: string | undefined;
  private ids = 0;
  private held = gate();

  nextId(): string {
    return `e${++this.ids}`;
  }

  /** Lets every run of the current process that is holding go on. */
  release(): void {
    this.held.open();
    this.held = gate();
  }

  holding(): Promise<void> {
    return this.held.opened;
  }

  restart(): void {
    this.generation++;
    this.held = gate();
  }
}

const RUN_MARKERS: ReadonlySet<string> = new Set<RunMarker>(["run_accepted", "run_started", "run_ended"]);

export function fakeLoopHarness(store: FakeStore): LoopHarness {
  const generation = store.generation;
  const alive = () => {
    if (store.generation !== generation) throw new Error("this process was restarted");
  };

  const logOf = (sessionId: string, stored: StoredSession, onRecord: (record: LogRecord) => void): LoopLog => {
    let closed = false;
    const write = (kind: string, data: Json): LogRecord => {
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
      onRecord(record);
      return record;
    };

    const run = (message: Prompt, emit: Parameters<LoopLog["run"]>[1]): LoopRun => {
      const pending: Prompt[] = [message];
      let finished = false;
      let stopped = false;
      const stop = gate();
      const done = (async () => {
        let outcome: Awaited<LoopRun["done"]>["outcome"] = { status: "completed" };
        while (pending.length > 0) {
          const taken = pending.shift() as Prompt;
          write("user_message", { text: taken.text });
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
        }
        finished = true;
        return { outcome, usage: { inputTokens: 1, outputTokens: 1 } };
      })();
      return {
        steer: async (steered) => {
          if (!finished) pending.push(steered);
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
        stored.records = source.slice(0, end).filter((record) => !RUN_MARKERS.has(record.kind));
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
