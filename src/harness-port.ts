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
  ForkSource,
  MessageKey,
  MessageSource,
  MessageStatus,
  ModelDescriptor,
  Prompt,
  Result,
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

export type Admission = { ok: true; message: MessageStatus; duplicate: boolean } | { ok: false; error: AgentError };

/**
 * Every call answers with a value. A read with no failure branch (`getMessage`, `attachment`, `list`, `models`,
 * `commands`) rejects with an `AgentRejection` of code `unavailable` when its storage cannot answer; any other
 * rejection is a harness failure, reported `internal`.
 */
export interface HarnessPort {
  readonly capabilities: Capabilities;
  /**
   * Looking up the key, recording the message and queueing it are one step per session, and the message is durable
   * when this resolves (SPEC v1 §3.3, §3.4). An unknown session is created.
   */
  submit(
    sessionId: string,
    message: Prompt,
    options: { whenBusy: WhenBusy; idempotencyKey?: string; source: MessageSource },
  ): Promise<Admission>;
  getMessage(sessionId: string, key: MessageKey): Promise<MessageStatus | undefined>;
  /**
   * A message's part of the history after `after` (any entry of the session), or from its own entry: through its
   * `lastEntryId` once it is done, through the newest entry while it is taken, nothing while it is queued. `message`
   * is its status as of the same read, so the two agree; `ended` says its end is recorded: a message the storage
   * refused to end reads as done without being so. An unknown message is `not_found`.
   */
  messageEntries(
    sessionId: string,
    messageId: string,
    after?: string,
  ): Promise<{ ok: true; message: MessageStatus; entries: Entry[]; ended: boolean } | { ok: false; error: AgentError }>;
  cancelMessage(sessionId: string, messageId: string): Promise<Result>;
  abort(sessionId: string): Promise<AbortResult>;
  read(sessionId: string, page: Page): Promise<PortRead>;
  /**
   * Live: an entry is reported once it is durable, a message's `done` once its end is. `after` is the newest published
   * entry when the event happened (for an entry, the one before it): where it sits against a read of the log, which a
   * live event does not otherwise say. Returns the unsubscribe.
   */
  watch(sessionId: string, listener: (event: SessionEvent, after: string | undefined) => void): () => void;
  attachment(sessionId: string, ref: string): Promise<Attachment | undefined>;
  create(sessionId: string, fork?: ForkSource): Promise<Result>;
  rewind(sessionId: string, entryId: string): Promise<Result>;
  compact(sessionId: string, options?: { instructions?: string }): Promise<Result>;
  update(sessionId: string, settings: SessionSettings): Promise<Result>;
  delete(sessionId: string): Promise<Result>;
  list(): Promise<SessionSummary[]>;
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<AgentCommand[]>;
}
