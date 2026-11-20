/**
 * Host-agnostic remote session controller: subscribes to a FastAgent instance's `sessions.events` stream,
 * reconciles live deltas/tools/retries and durable entries into an immutable view snapshot, handles reconnects
 * from the last seen entry, and prevents stale-generation races across session switches.
 */
import {
  type Agent,
  AgentError,
  type AgentInfo,
  type ContentPart,
  type CreateSessionOptions,
  type Entry,
  type Json,
  type Message,
  type ScheduleRun,
  type ScheduleState,
  type SendRequest,
  type Session,
  type SessionChanges,
  type SessionEvent,
  type Wakeup,
} from "@fastagent-sh/client";

export interface ActiveTool {
  toolCallId: string;
  name: string;
  args: Json;
  progress?: string;
}

export interface LiveReply {
  text: string;
  thinking: string;
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface RemoteViewState {
  status: ConnectionStatus;
  remoteName?: string;
  agentInfo?: AgentInfo;
  session?: Session;
  liveReply?: LiveReply;
  activeTools: readonly ActiveTool[];
  retrying?: RetryNotice;
  lastEntryId?: string;
  lastError?: string;
}

export interface RemoteControllerCallbacks {
  onStateChange?: (state: RemoteViewState) => void;
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

  private agent?: Agent;
  private streamAbort?: AbortController;
  private generation = 0;
  private seenEntryIds = new Set<string>();
  private state: RemoteViewState = { status: "disconnected", activeTools: [] };

  constructor(callbacks: RemoteControllerCallbacks = {}, options: RemoteControllerOptions = {}) {
    this.callbacks = callbacks;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.baseReconnectMs = options.baseReconnectMs ?? DEFAULT_BASE_RECONNECT_MS;
    this.maxReconnectMs = options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS;
  }

  getState(): RemoteViewState {
    return this.state;
  }

  isConnected(): boolean {
    return this.agent !== undefined && this.state.session !== undefined && this.state.status !== "disconnected";
  }

  async connect(remoteName: string, agent: Agent, options: { sessionId?: string } = {}): Promise<Session> {
    const gen = this.nextGeneration();
    this.agent = agent;
    this.seenEntryIds.clear();
    this.setState({
      status: "connecting",
      remoteName,
      activeTools: [],
    });

    try {
      const info = await agent.info();
      if (this.generation !== gen) return this.requireSession();
      const session = options.sessionId ? await agent.sessions.get(options.sessionId) : await agent.sessions.create();
      if (this.generation !== gen) return session;

      this.setState({
        status: "connected",
        remoteName,
        agentInfo: info,
        session,
        activeTools: [],
      });
      this.startEventLoop(gen, agent, session.id, options.sessionId ? "start" : undefined);
      return session;
    } catch (error) {
      if (this.generation === gen) {
        this.agent = undefined;
        this.setState({
          status: "disconnected",
          activeTools: [],
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
    this.setState({
      status: "disconnected",
      activeTools: [],
    });
  }

  async switchSession(sessionId: string): Promise<Session> {
    const agent = this.requireAgent();
    const remoteName = this.state.remoteName;
    const agentInfo = this.state.agentInfo;
    const gen = this.nextGeneration();
    this.seenEntryIds.clear();

    const session = await agent.sessions.get(sessionId);
    if (this.generation !== gen) return session;

    this.setState({
      status: "connected",
      ...(remoteName !== undefined ? { remoteName } : {}),
      ...(agentInfo !== undefined ? { agentInfo } : {}),
      session,
      activeTools: [],
    });
    this.startEventLoop(gen, agent, session.id, "start");
    return session;
  }

  async createSession(options?: CreateSessionOptions): Promise<Session> {
    const agent = this.requireAgent();
    const remoteName = this.state.remoteName;
    const agentInfo = this.state.agentInfo;
    const gen = this.nextGeneration();
    this.seenEntryIds.clear();

    const session = await agent.sessions.create(options);
    if (this.generation !== gen) return session;

    this.setState({
      status: "connected",
      ...(remoteName !== undefined ? { remoteName } : {}),
      ...(agentInfo !== undefined ? { agentInfo } : {}),
      session,
      activeTools: [],
    });
    this.startEventLoop(gen, agent, session.id, options?.forkFrom ? "start" : undefined);
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

  async send(content: SendRequest["content"], options: { whenBusy?: SendRequest["whenBusy"] } = {}): Promise<Message> {
    const agent = this.requireAgent();
    const session = this.requireSession();
    const whenBusy = options.whenBusy ?? (session.status === "running" ? "steer" : "queue");
    const message = await agent.messages.send({
      sessionId: session.id,
      content,
      whenBusy,
    });
    if (this.state.session?.id === session.id && this.state.session.status === "idle") {
      this.setState({
        ...this.state,
        session: { ...this.state.session, status: "running" },
        lastError: undefined,
      });
    }
    return message;
  }

  async cancel(): Promise<{ stopped: string[] }> {
    const agent = this.requireAgent();
    const session = this.requireSession();
    return agent.sessions.cancel(session.id);
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

  async listSchedules(): Promise<ScheduleState[]> {
    return this.requireAgent().schedules.list();
  }

  async runSchedule(name: string): Promise<ScheduleRun> {
    return this.requireAgent().schedules.run(name);
  }

  async listWakeups(): Promise<Wakeup[]> {
    return this.requireAgent().wakeups.list();
  }

  async cancelWakeup(id: string): Promise<Wakeup> {
    return this.requireAgent().wakeups.cancel(id);
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
            this.applyEvent(event, !sawSnapshot);
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
          this.setState({
            ...this.state,
            status: "disconnected",
            liveReply: undefined,
            activeTools: [],
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

  private applyEvent(event: SessionEvent, replayed: boolean): void {
    switch (event.type) {
      case "state": {
        const reply = event.session.reply;
        this.setState({
          ...this.state,
          status: "connected",
          session: event.session,
          liveReply: reply ? { text: reply.text, thinking: reply.thinking ?? "" } : undefined,
          retrying: undefined,
          ...(event.session.status === "idle" ? { activeTools: [] } : {}),
        });
        return;
      }
      case "delta": {
        const current = this.state.liveReply ?? { text: "", thinking: "" };
        const liveReply: LiveReply =
          event.channel === "thinking"
            ? { text: current.text, thinking: current.thinking + event.text }
            : { text: current.text + event.text, thinking: current.thinking };
        const session =
          this.state.session && this.state.session.status === "idle"
            ? { ...this.state.session, status: "running" as const }
            : this.state.session;
        this.setState({
          ...this.state,
          ...(session !== undefined ? { session } : {}),
          liveReply,
          retrying: undefined,
        });
        return;
      }
      case "tool_started": {
        const existing = this.state.activeTools.some((t) => t.toolCallId === event.toolCallId);
        const activeTools = existing
          ? this.state.activeTools
          : [...this.state.activeTools, { toolCallId: event.toolCallId, name: event.name, args: event.args }];
        this.setState({ ...this.state, activeTools });
        return;
      }
      case "tool_progress": {
        const found = this.state.activeTools.some((t) => t.toolCallId === event.toolCallId);
        const activeTools = found
          ? this.state.activeTools.map((t) => (t.toolCallId === event.toolCallId ? { ...t, progress: event.text } : t))
          : [...this.state.activeTools, { toolCallId: event.toolCallId, name: "tool", args: {}, progress: event.text }];
        this.setState({ ...this.state, activeTools });
        return;
      }
      case "retrying": {
        this.setState({
          ...this.state,
          retrying: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            reason: event.reason,
          },
        });
        return;
      }
      case "entry": {
        const entry = event.entry;
        let nextLiveReply = this.state.liveReply;
        let nextActiveTools = this.state.activeTools;
        let nextRetrying = this.state.retrying;

        if (entry.kind === "assistant") {
          nextLiveReply = undefined;
          nextRetrying = undefined;
        } else if (entry.kind === "tool_result") {
          const data = entry.data as { toolCallId?: unknown } | null;
          if (data && typeof data.toolCallId === "string") {
            nextActiveTools = this.state.activeTools.filter((t) => t.toolCallId !== data.toolCallId);
          }
        }

        this.setState({
          ...this.state,
          lastEntryId: entry.id,
          liveReply: nextLiveReply,
          activeTools: nextActiveTools,
          retrying: nextRetrying,
        });

        if (!this.seenEntryIds.has(entry.id)) {
          this.seenEntryIds.add(entry.id);
          this.callbacks.onEntry?.(entry, { replayed });
        }
        return;
      }
      case "done": {
        const failed = event.message.status === "failed" ? event.message.error?.message : undefined;
        const session = this.state.session ? { ...this.state.session, status: "idle" as const } : undefined;
        this.setState({
          ...this.state,
          ...(session !== undefined ? { session } : {}),
          liveReply: undefined,
          activeTools: [],
          retrying: undefined,
          ...(failed !== undefined ? { lastError: failed } : {}),
        });
        this.callbacks.onDone?.(event.message);
        return;
      }
      case "stream_error":
        return;
    }
  }
}

export function buildSendContent(
  text: string,
  images?: readonly { mimeType: string; data: string }[],
): SendRequest["content"] {
  if (!images || images.length === 0) return text;
  const parts: Extract<ContentPart, { type: "text" } | { type: "image"; data: string }>[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({ type: "image", mimeType: img.mimeType, data: img.data });
  }
  return parts;
}
