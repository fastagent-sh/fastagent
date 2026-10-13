/**
 * The harness port: what the serving layer calls to run a session's work (docs/design/agent-service.md §9.1). It is
 * the protocol's semantics without the protocol's surface: no id minting, no request validation, no streams. A
 * durable harness implements it directly; a harness that is only a loop gets it from `loopPort`.
 */
import type {
  AbortResult,
  AgentCommand,
  AgentError,
  Attachment,
  Capabilities,
  Entry,
  ModelDescriptor,
  Prompt,
  Result,
  RunKey,
  RunSource,
  RunStatus,
  SessionEvent,
  SessionSettings,
  SessionState,
  SessionSummary,
  WhenBusy,
} from "./protocol.ts";

/** A page of the published entries: after an entry (`null`: from the first), or before one (`null`: the newest). */
export type Page = { after: string | null; limit: number } | { before: string | null; limit: number };

export type PortRead =
  | { ok: true; state: SessionState; entries: Entry[]; more: { before: boolean; after: boolean } }
  | { ok: false; error: AgentError };

export type Admission =
  | { ok: true; run: RunStatus; joined: boolean; duplicate: boolean }
  | { ok: false; error: AgentError };

export interface HarnessPort {
  readonly capabilities: Capabilities;
  /**
   * Looking up the key, recording the run and queueing it are one step per session, and the run is durable when this
   * resolves (SPEC v1 §3.3, §3.4). An unknown session is created.
   */
  submit(
    sessionId: string,
    message: Prompt,
    options: { whenBusy: WhenBusy; idempotencyKey?: string; source: RunSource },
  ): Promise<Admission>;
  getRun(sessionId: string, key: RunKey): Promise<RunStatus | undefined>;
  /** A run's published entries after `after` (any entry of the session), or all of them. */
  runEntries(
    sessionId: string,
    runId: string,
    after?: string,
  ): Promise<{ ok: true; entries: Entry[] } | { ok: false; error: AgentError }>;
  cancelRun(sessionId: string, runId: string): Promise<Result>;
  abort(sessionId: string): Promise<AbortResult>;
  read(sessionId: string, page: Page): Promise<PortRead>;
  /** Live: an entry is reported once it is durable. Returns the unsubscribe. */
  watch(sessionId: string, listener: (event: SessionEvent) => void): () => void;
  attachment(sessionId: string, ref: string): Promise<Attachment | undefined>;
  create(sessionId: string, fork?: { sessionId: string; entryId?: string }): Promise<Result>;
  rewind(sessionId: string, entryId: string): Promise<Result>;
  compact(sessionId: string, options?: { instructions?: string }): Promise<Result>;
  update(sessionId: string, settings: SessionSettings): Promise<Result>;
  delete(sessionId: string): Promise<Result>;
  list(): Promise<SessionSummary[]>;
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<AgentCommand[]>;
}
