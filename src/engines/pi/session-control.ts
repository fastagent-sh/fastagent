/**
 * The pi implementation of the session control plane's OBSERVATION half (design Phase 1):
 * `state`/`entries`/`events` over invoke-driven runs. `createPiSessionControl` returns the neutral
 * `SessionControl` plus the {@link SessionObserver} to plug into the invoke pipeline
 * (`createPiAgentFromHarness({ observer })`) — the hub derives everything from the rich event
 * stream, holds no durable state of its own, and never writes: durable truth stays in the session
 * repository (read via {@link PiSessionReader}), live truth in the events the data plane emits.
 *
 * Phase 2 (steer/follow_up/abort/compact/set_model/set_thinking) lands in `dispatch`; until then
 * every command is rejected before acceptance with `unsupported_capability` — a client gating on
 * `capabilities()` never sends them.
 */
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Json } from "../../agent.ts";
import {
  type SessionCapabilities,
  type SessionCommand,
  type SessionControl,
  type SessionEntries,
  type SessionEntry,
  type SessionEvent,
  type SessionResult,
  type SessionState,
  UNSUPPORTED_CAPABILITY_CODE,
} from "../../session.ts";
import type { SessionObserver } from "./invoke.ts";
import type { PiSessionReader } from "./sessions.ts";

// ── Entry normalization (durable plane) ──────────────────────────────────────

/** Concatenated plain text of a message's content blocks (the L0 rendering payload). A custom
 *  AgentMessage role may carry no `content` at all — that reads as empty, not a crash. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * pi `SessionTreeEntry` → neutral {@link SessionEntry}. Message entries map onto the guaranteed
 * kind vocabulary (user/assistant/tool) with a minimal render payload; every other engine record
 * keeps its pi type as an open-set kind with an EMPTY payload — present so `parentId` chains and
 * cursors stay intact, skippable by contract, and no pi message class leaks through the adapter.
 */
function toSessionEntry(entry: SessionTreeEntry): SessionEntry {
  const base = {
    id: entry.id,
    parentId: entry.parentId ?? undefined,
    timestamp: Date.parse(entry.timestamp),
  };
  if (entry.type === "message") {
    const m = entry.message;
    if (m.role === "user") return { ...base, kind: "user", data: { text: textOf(m.content) } };
    if (m.role === "assistant") {
      const toolCalls = (m.content as Array<{ type: string; id?: string; name?: string }>)
        .filter((b) => b.type === "toolCall")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "" }));
      const data: Json = { text: textOf(m.content) };
      if (toolCalls.length > 0) (data as { toolCalls?: Json }).toolCalls = toolCalls;
      return { ...base, kind: "assistant", data };
    }
    if (m.role === "toolResult") {
      return {
        ...base,
        kind: "tool",
        data: {
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          isError: m.isError ?? false,
          text: textOf(m.content),
        },
      };
    }
    // A custom AgentMessage role (channel/extension-defined): open-set kind, skippable.
    return { ...base, kind: `message:${(m as { role: string }).role}`, data: {} };
  }
  return { ...base, kind: entry.type, data: {} };
}

// ── Live fan-out (events plane) ──────────────────────────────────────────────

/** One subscriber's unbounded push→pull queue. Ends only when the CONSUMER stops iterating. */
class Subscriber {
  private buffer: SessionEvent[] = [];
  private wake?: () => void;

  push(event: SessionEvent): void {
    this.buffer.push(event);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *iterate(onDone: () => void): AsyncGenerator<SessionEvent> {
    try {
      while (true) {
        while (this.buffer.length > 0) yield this.buffer.shift() as SessionEvent;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    } finally {
      onDone(); // consumer broke/returned — unregister
    }
  }
}

// ── The hub ──────────────────────────────────────────────────────────────────

export interface CreatePiSessionControlOptions {
  /** Read-only access to the durable session repository (the same root the agent writes). */
  sessions: PiSessionReader;
}

/**
 * Build the observation hub. Wire `observer` into the SAME agent assembly that serves the sessions:
 *
 * ```ts
 * const { control, observer } = createPiSessionControl({ sessions });
 * const agent = createPiAgent({ ..., sessions, observer });
 * ```
 */
export function createPiSessionControl(options: CreatePiSessionControlOptions): {
  control: SessionControl;
  observer: SessionObserver;
} {
  const { sessions } = options;
  /** Live run state per session — derived purely from run_started/run_settled. */
  const active = new Map<string, string>(); // session → activeRunId
  const subscribers = new Map<string, Set<Subscriber>>();

  const observer: SessionObserver = (session, event) => {
    if (event.type === "run_started" && event.runId) active.set(session, event.runId);
    else if (event.type === "run_settled") active.delete(session);
    const subs = subscribers.get(session);
    if (subs) for (const sub of [...subs]) sub.push(event);
  };

  const capabilities: SessionCapabilities = {
    steering: false,
    followUp: false,
    manualCompaction: false,
    modelSelection: false,
    thinkingLevel: false,
    toolProgress: true, // tool_progress IS delivered (replace-semantics snapshots)
    usage: false,
  };

  const control: SessionControl = {
    capabilities: () => capabilities,

    async state(session): Promise<SessionState> {
      const activeRunId = active.get(session);
      const opened = await sessions.openIfExists(session);
      const leafEntryId = opened ? ((await opened.getLeafId()) ?? undefined) : undefined;
      return {
        status: activeRunId ? "running" : "idle",
        ...(activeRunId ? { activeRunId } : {}),
        pending: { steering: 0, followUp: 0 },
        ...(leafEntryId ? { leafEntryId } : {}),
      };
    },

    async entries(session, opts): Promise<SessionEntries> {
      const opened = await sessions.openIfExists(session);
      if (!opened) return { entries: [] };
      const all = (await opened.getEntries()).map(toSessionEntry);
      const leafEntryId = (await opened.getLeafId()) ?? undefined;
      let entries = all;
      if (opts?.since !== undefined) {
        const idx = all.findIndex((e) => e.id === opts.since);
        // Unknown cursor → full backfill (correct, merely larger): the client's cursor may predate
        // a repository the session was rebuilt into; silently skipping records would lose history.
        if (idx >= 0) entries = all.slice(idx + 1);
      }
      return { entries, ...(leafEntryId ? { leafEntryId } : {}) };
    },

    events(session): AsyncIterable<SessionEvent> {
      const sub = new Subscriber();
      let set = subscribers.get(session);
      if (!set) {
        set = new Set();
        subscribers.set(session, set);
      }
      set.add(sub);
      return sub.iterate(() => {
        set.delete(sub);
        if (set.size === 0) subscribers.delete(session);
      });
    },

    async dispatch(_session, command: SessionCommand): Promise<SessionResult> {
      // Phase 1 is the observation plane only. Rejected BEFORE acceptance (safe to retry after
      // upgrading); a capability-gating client never lands here.
      return {
        ok: false,
        error: {
          code: UNSUPPORTED_CAPABILITY_CODE,
          message: `command "${command.type}" is not supported by this runtime (observation plane only)`,
          retryable: false,
        },
      };
    },
  };

  return { control, observer };
}
