/**
 * Host-agnostic remote session controller: subscribes to a FastAgent instance's `sessions.events` stream,
 * reconciles live deltas/tools/retries and durable entries into an immutable view snapshot, handles reconnects
 * from the last seen entry, and prevents stale-generation races across session switches.
 */
import {
  type Agent,
  AgentError,
  type CreateSessionOptions,
  type Entry,
  type Json,
  type Message,
  type QueuedMessage,
  type SendRequest,
  type Session,
  type SessionChanges,
  type SessionEvent,
} from "@fastagent-sh/client";
import {
  type ActiveTool,
  EMPTY_VIEW_STATE,
  type LiveReply,
  type RemoteViewState,
  activeToolsFromSession,
  autoTitleOf,
  buildSendContent,
  omitKeys,
  previewOfContent,
  reduceSessionEvent,
} from "./view-state.ts";

export { type ActiveTool, type LiveReply, type RemoteViewState, buildSendContent };

export interface RemoteControllerCallbacks {
  onStateChange?: (state: RemoteViewState) => void;
  onSessionReady?: (state: RemoteViewState, meta: { fresh: boolean; resumed: boolean }) => void;
  onEntry?: (entry: Entry, meta: { replayed: boolean }) => void;
  onDone?: (message: Message) => void;
  onError?: (error: Error) => void;
}

export interface RemoteControllerOptions {
  /** Override sleep between reconnect attempts (for deterministic tests). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  baseReconnectMs?: number;
  maxReconnectMs?: number;
}

const DEFAULT_BASE_RECONNECT_MS = 500;
const DEFAULT_MAX_RECONNECT_MS = 10_000;
const FATAL_STREAM_CODES = new Set(["not_found", "unauthorized", "invalid_request"]);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFatalError(error: unknown): boolean {
  return error instanceof AgentError && FATAL_STREAM_CODES.has(error.code);
}

export class RemoteController {
  private readonly callbacks: RemoteControllerCallbacks;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly baseReconnectMs: number;
  private readonly maxReconnectMs: number;

  private agent?: Agent | undefined;
  private streamAbort?: AbortController | undefined;
  private generation = 0;
  private eventSeq = 0;
  private seenEntryIds = new Set<string>();
  private toolCallArgs = new Map<string, Json>();
  private lastAssistantText?: string | undefined;
  private autoTitleAttempted = false;
  private inFlightSends = 0;
  private state: RemoteViewState = EMPTY_VIEW_STATE;

  constructor(callbacks: RemoteControllerCallbacks = {}, options: RemoteControllerOptions = {}) {
    this.callbacks = callbacks;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.baseReconnectMs = options.baseReconnectMs ?? DEFAULT_BASE_RECONNECT_MS;
    this.maxReconnectMs = options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS;
  }

  getState(): RemoteViewState {
    return this.state;
  }

  getToolCallArgs(toolCallId: string): Json | undefined {
    return this.toolCallArgs.get(toolCallId);
  }

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  getSeenEntryIds(): ReadonlySet<string> {
    return new Set(this.seenEntryIds);
  }

  isConnected(): boolean {
    return this.agent !== undefined && this.state.session !== undefined && this.state.status !== "disconnected";
  }

  async connect(
    remoteName: string,
    agent: Agent,
    options: {
      sessionId?: string;
      after?: string;
      seenEntryIds?: Iterable<string>;
      resumed?: boolean;
    } = {},
  ): Promise<Session> {
    const wasConnected = this.isConnected();
    const beforeGen = wasConnected ? this.generation : this.nextGeneration();
    if (!wasConnected) {
      this.setState({
        status: "connecting",
        remoteName,
        activeTools: [],
        queuedMessages: [],
        queuedPreviews: {},
        sending: false,
        canceling: false,
        compacting: false,
      });
    }

    try {
      const info = await agent.info();
      if (this.generation !== beforeGen) {
        throw new Error("Connection canceled");
      }
      const session = options.sessionId ? await agent.sessions.get(options.sessionId) : await agent.sessions.create();
      if (this.generation !== beforeGen) {
        throw new Error("Connection canceled");
      }

      const sameSession = this.state.session?.id === session.id;
      const gen = wasConnected ? this.nextGeneration() : beforeGen;
      this.agent = agent;
      this.seenEntryIds = new Set(options.seenEntryIds ?? []);
      if (!sameSession) {
        this.toolCallArgs.clear();
        this.lastAssistantText = undefined;
      }
      this.inFlightSends = 0;
      this.autoTitleAttempted = Boolean(session.title || options.sessionId);
      this.setState({
        status: "connected",
        remoteName,
        agentInfo: info,
        session,
        activeTools: activeToolsFromSession(session),
        queuedMessages: session.queuedMessages ?? [],
        queuedPreviews: {},
        sending: false,
        canceling: false,
        compacting: session.compacting === true,
        ...(options.after && options.after !== "start" ? { lastEntryId: options.after } : {}),
      });
      this.callbacks.onSessionReady?.(this.state, {
        fresh: options.sessionId === undefined,
        resumed: options.resumed === true,
      });
      this.startEventLoop(gen, agent, session.id, options.after ?? "start");
      return session;
    } catch (error) {
      if (!wasConnected && this.generation === beforeGen) {
        this.agent = undefined;
        this.setState({
          status: "disconnected",
          activeTools: [],
          queuedMessages: [],
          queuedPreviews: {},
          sending: false,
          canceling: false,
          compacting: false,
          lastError: errorMessageOf(error),
        });
      }
      throw error;
    }
  }

  disconnect(): void {
    this.nextGeneration();
    this.agent = undefined;
    this.seenEntryIds.clear();
    this.toolCallArgs.clear();
    this.lastAssistantText = undefined;
    this.inFlightSends = 0;
    this.autoTitleAttempted = false;
    this.setState({
      status: "disconnected",
      activeTools: [],
      queuedMessages: [],
      queuedPreviews: {},
      sending: false,
      canceling: false,
      compacting: false,
    });
  }

  async switchSession(sessionId: string): Promise<Session> {
    const agent = this.requireAgent();
    const remoteName = this.state.remoteName;
    const agentInfo = this.state.agentInfo;
    const beforeGen = this.generation;

    const session = await agent.sessions.get(sessionId);
    if (this.generation !== beforeGen) {
      throw new Error("Session transition superseded");
    }

    const gen = this.nextGeneration();
    this.seenEntryIds.clear();
    this.toolCallArgs.clear();
    this.lastAssistantText = undefined;
    this.inFlightSends = 0;
    this.autoTitleAttempted = true;
    this.setState({
      status: "connected",
      ...(remoteName !== undefined ? { remoteName } : {}),
      ...(agentInfo !== undefined ? { agentInfo } : {}),
      session,
      activeTools: activeToolsFromSession(session),
      queuedMessages: session.queuedMessages ?? [],
      queuedPreviews: {},
      sending: false,
      canceling: false,
      compacting: session.compacting === true,
    });
    this.callbacks.onSessionReady?.(this.state, { fresh: false, resumed: false });
    this.startEventLoop(gen, agent, session.id, "start");
    return session;
  }

  async createSession(options?: CreateSessionOptions): Promise<Session> {
    const agent = this.requireAgent();
    const remoteName = this.state.remoteName;
    const agentInfo = this.state.agentInfo;
    const beforeGen = this.generation;

    const session = await agent.sessions.create(options);
    if (this.generation !== beforeGen) {
      throw new Error("Session transition superseded");
    }

    const gen = this.nextGeneration();
    this.seenEntryIds.clear();
    this.toolCallArgs.clear();
    this.lastAssistantText = undefined;
    this.inFlightSends = 0;
    this.autoTitleAttempted = Boolean(session.title || options?.forkFrom);
    this.setState({
      status: "connected",
      ...(remoteName !== undefined ? { remoteName } : {}),
      ...(agentInfo !== undefined ? { agentInfo } : {}),
      session,
      activeTools: activeToolsFromSession(session),
      queuedMessages: session.queuedMessages ?? [],
      queuedPreviews: {},
      sending: false,
      canceling: false,
      compacting: session.compacting === true,
    });
    this.callbacks.onSessionReady?.(this.state, { fresh: !options?.forkFrom, resumed: false });
    this.startEventLoop(gen, agent, session.id, "start");
    return session;
  }

  async forkSession(entryId?: string): Promise<Session> {
    const session = this.requireSession();
    return this.createSession({
      forkFrom: {
        sessionId: session.id,
        ...(entryId !== undefined ? { entryId } : {}),
      },
    });
  }

  /** Create a remote session without switching this controller's active stream. */
  async createRemoteSession(options?: CreateSessionOptions): Promise<Session> {
    return this.requireAgent().sessions.create(options);
  }

  /** Fork the active remote session on the server without switching this controller's active stream. */
  async forkRemoteSession(entryId?: string): Promise<Session> {
    const session = this.requireSession();
    return this.createRemoteSession({
      forkFrom: {
        sessionId: session.id,
        ...(entryId !== undefined ? { entryId } : {}),
      },
    });
  }

  async send(content: SendRequest["content"], options: { whenBusy?: SendRequest["whenBusy"] } = {}): Promise<Message> {
    const agent = this.requireAgent();
    const session = this.requireSession();
    const gen = this.generation;
    const whenBusy = options.whenBusy ?? (session.status === "running" ? "steer" : "queue");
    const preview = previewOfContent(content);
    this.inFlightSends += 1;
    this.setState({ ...this.state, sending: true, lastError: undefined });

    let message: Message;
    try {
      message = await agent.messages.send({
        sessionId: session.id,
        content,
        whenBusy,
      });
    } finally {
      if (this.generation === gen) {
        this.inFlightSends = Math.max(0, this.inFlightSends - 1);
        const stillSending = this.inFlightSends > 0;
        if (this.state.sending !== stillSending) {
          this.setState({ ...this.state, sending: stillSending });
        }
      }
    }

    if (this.generation === gen && this.state.session?.id === session.id) {
      const nextSession =
        this.state.session.status === "idle"
          ? { ...this.state.session, status: "running" as const }
          : this.state.session;
      let nextQueued = this.state.queuedMessages;
      let nextPreviews = this.state.queuedPreviews;
      if (message.status === "queued" && !nextQueued.some((q) => q.id === message.id)) {
        const mode: QueuedMessage["mode"] = whenBusy === "steer" ? "steer" : "queue";
        nextQueued = [...nextQueued, { id: message.id, mode }];
        if (preview) nextPreviews = { ...nextPreviews, [message.id]: preview };
      }
      if (nextSession !== this.state.session || nextQueued !== this.state.queuedMessages) {
        this.eventSeq += 1;
        this.setState({
          ...this.state,
          session: nextSession,
          queuedMessages: nextQueued,
          queuedPreviews: nextPreviews,
          sending: this.inFlightSends > 0,
          lastError: undefined,
        });
      }
      if (!this.autoTitleAttempted && !this.state.session.title) {
        const autoTitle = autoTitleOf(preview);
        if (autoTitle) {
          this.autoTitleAttempted = true;
          void agent.sessions
            .update(session.id, { title: autoTitle })
            .then((updated) => {
              if (this.generation !== gen || this.state.session?.id !== session.id) return;
              if (!this.state.session.title && updated.title) {
                this.setState({ ...this.state, session: { ...this.state.session, title: updated.title } });
              }
            })
            .catch(() => {
              // Older servers without title support reject silently without interrupting chat.
            });
        }
      }
    }
    return message;
  }

  async cancel(): Promise<{ stopped: string[] }> {
    const agent = this.requireAgent();
    const session = this.requireSession();
    const gen = this.generation;
    this.setState({ ...this.state, canceling: true });
    let result: { stopped: string[] };
    try {
      result = await agent.sessions.cancel(session.id);
    } finally {
      if (this.generation === gen && this.state.canceling) {
        this.setState({ ...this.state, canceling: false });
      }
    }
    if (this.generation === gen && this.state.session?.id === session.id && result.stopped.length > 0) {
      const stoppedSet = new Set(result.stopped);
      const remaining = this.state.queuedMessages.filter((q) => !stoppedSet.has(q.id));
      const nextPreviews = omitKeys(this.state.queuedPreviews, stoppedSet);
      if (remaining.length !== this.state.queuedMessages.length) {
        this.eventSeq += 1;
        this.setState({ ...this.state, queuedMessages: remaining, queuedPreviews: nextPreviews });
      }
    }
    return result;
  }

  async compact(instructions?: string): Promise<void> {
    const agent = this.requireAgent();
    const session = this.requireSession();
    await agent.sessions.compact(session.id, instructions ? { instructions } : undefined);
  }

  async updateSession(changes: SessionChanges): Promise<Session> {
    const agent = this.requireAgent();
    const session = this.requireSession();
    const updated = await agent.sessions.update(session.id, changes);
    if (this.state.session?.id === updated.id) {
      this.setState({ ...this.state, session: updated });
    }
    return updated;
  }

  async listSessions(limit = 30): Promise<Session[]> {
    const page = await this.requireAgent().sessions.list({ limit });
    return page.data;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const agent = this.requireAgent();
    await agent.sessions.delete(sessionId);
    if (this.state.session?.id === sessionId) {
      this.disconnect();
    }
  }

  private nextGeneration(): number {
    this.generation += 1;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    return this.generation;
  }

  private requireAgent(): Agent {
    if (!this.agent) throw new Error("Not connected to a remote FastAgent");
    return this.agent;
  }

  private requireSession(): Session {
    if (!this.state.session) throw new Error("No active remote session");
    return this.state.session;
  }

  private setState(next: RemoteViewState): void {
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private startEventLoop(gen: number, agent: Agent, sessionId: string, initialAfter: string | undefined): void {
    const abort = new AbortController();
    this.streamAbort = abort;

    void (async () => {
      let attempt = 0;
      let after = initialAfter;

      while (this.generation === gen && !abort.signal.aborted) {
        let sawSnapshot = false;
        let fatalStreamError: Error | undefined;

        try {
          for await (const event of agent.sessions.events(sessionId, {
            ...(after !== undefined ? { after } : {}),
            signal: abort.signal,
          })) {
            if (this.generation !== gen || abort.signal.aborted) return;

            if (event.type === "state") {
              sawSnapshot = true;
              attempt = 0;
            }
            if (event.type === "stream_error") {
              const err = new AgentError(event.error);
              this.setState({
                ...this.state,
                lastError: event.error.message,
              });
              this.callbacks.onError?.(err);
              if (!event.error.retryable && FATAL_STREAM_CODES.has(event.error.code)) {
                fatalStreamError = err;
              }
              break;
            }
            this.applyEvent(gen, agent, sessionId, event, !sawSnapshot);
          }
        } catch (error) {
          if (this.generation !== gen || abort.signal.aborted) return;
          const err = error instanceof Error ? error : new Error(String(error));
          this.setState({
            ...this.state,
            lastError: err.message,
          });
          this.callbacks.onError?.(err);
          if (isFatalError(error)) fatalStreamError = err;
        }

        if (this.generation !== gen || abort.signal.aborted) return;

        if (fatalStreamError) {
          this.inFlightSends = 0;
          this.setState({
            ...this.state,
            status: "disconnected",
            liveReply: undefined,
            activeTools: [],
            queuedMessages: [],
            queuedPreviews: {},
            sending: false,
            canceling: false,
            compacting: false,
            retrying: undefined,
            lastError: fatalStreamError.message,
          });
          return;
        }

        const delay = Math.min(this.baseReconnectMs * 2 ** attempt, this.maxReconnectMs);
        attempt += 1;
        after = this.state.lastEntryId ?? after;
        this.setState({
          ...this.state,
          status: "reconnecting",
        });
        await this.sleepFn(delay, abort.signal);
      }
    })();
  }

  private refreshSession(gen: number, agent: Agent, sessionId: string): void {
    const seqAtStart = this.eventSeq;
    void agent.sessions
      .get(sessionId)
      .then((fresh) => {
        if (this.generation !== gen || this.state.session?.id !== sessionId) return;
        const session = this.eventSeq === seqAtStart ? fresh : { ...this.state.session, usage: fresh.usage };
        this.setState({
          ...this.state,
          session,
          ...(this.eventSeq === seqAtStart
            ? {
                queuedMessages: fresh.queuedMessages ?? [],
                compacting: fresh.compacting === true,
              }
            : {}),
        });
      })
      .catch(() => {
        // Ignore transient refresh failures; the active event stream or reconnect snapshot will resync state.
      });
  }

  private applyEvent(gen: number, agent: Agent, sessionId: string, event: SessionEvent, replayed: boolean): void {
    this.eventSeq += 1;
    const reduced = reduceSessionEvent(this.state, event, { replayed });
    if (reduced.lastAssistantText !== undefined) {
      this.lastAssistantText = reduced.lastAssistantText;
    }
    if (reduced.toolCallArgs !== undefined) {
      for (const [toolCallId, args] of reduced.toolCallArgs) {
        this.toolCallArgs.set(toolCallId, args);
      }
    }
    if (reduced.state !== this.state) {
      this.setState(reduced.state);
    }
    if (reduced.errorMessage !== undefined) {
      this.callbacks.onError?.(new Error(reduced.errorMessage));
    }
    if (reduced.entry !== undefined && !this.seenEntryIds.has(reduced.entry.id)) {
      this.seenEntryIds.add(reduced.entry.id);
      this.callbacks.onEntry?.(reduced.entry, { replayed });
    }
    if (reduced.doneMessage !== undefined) {
      this.callbacks.onDone?.(reduced.doneMessage);
      this.refreshSession(gen, agent, sessionId);
    }
  }
}
