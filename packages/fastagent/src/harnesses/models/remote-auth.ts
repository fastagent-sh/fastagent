/**
 * Server-side remote authentication manager: drives pi-ai's interactive `loginOver` flows over stateless HTTP
 * request/response turns and persists credentials directly into the instance's durable storage.
 */
import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, Provider } from "@earendil-works/pi-ai";
import {
  type AuthApi,
  type AuthFlowState,
  type AuthLoginInput,
  type AuthMethod,
  type AuthPromptInfo,
  type AuthProviderStatus,
  type StartAuthLoginRequest,
  agentError,
} from "@fastagent-sh/client/agent-api";
import { beginWork } from "../../busy.ts";
import type { DurableCredentialStore } from "../pi-durable/credentials.ts";
import type { ModelEnvironment } from "./environment.ts";
import { SignInCancelled, loginOver } from "./login.ts";
import { interactiveAuth, loginProviders } from "./models.ts";

const MAX_ACTIVE_FLOWS = 8;
const ACTIVE_FLOW_TTL_MS = 5 * 60_000;
const SETTLED_FLOW_TTL_MS = 60_000;
const INITIAL_WAIT_MS = 1_500;
const SUBMIT_WAIT_MS = 15_000;
const MAX_MESSAGES = 20;

export interface AuthManager extends AuthApi {
  /** Abort all in-flight login flows (called when the served instance closes). */
  close(): void;
}

interface PendingPrompt {
  info: AuthPromptInfo;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

interface FlowRecord {
  readonly flowId: string;
  readonly provider: string;
  readonly method: AuthMethod;
  readonly abort: AbortController;
  readonly startedAt: number;
  readonly release: () => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  updatedAt: number;
  settledAt?: number;
  version: number;
  status: AuthFlowState["status"];
  authUrl?: { url: string; instructions?: string };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  };
  pending?: PendingPrompt;
  messages: string[];
  verified?: "ok" | "unknown" | "n/a";
  error?: string;
  waiters: Set<() => void>;
}

const isTerminal = (status: AuthFlowState["status"]): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

function snapshotOf(flow: FlowRecord): AuthFlowState {
  return {
    flowId: flow.flowId,
    provider: flow.provider,
    method: flow.method,
    status: flow.status,
    ...(flow.authUrl === undefined ? {} : { authUrl: flow.authUrl }),
    ...(flow.deviceCode === undefined ? {} : { deviceCode: flow.deviceCode }),
    ...(flow.pending === undefined ? {} : { prompt: flow.pending.info }),
    messages: [...flow.messages],
    ...(flow.verified === undefined ? {} : { verified: flow.verified }),
    ...(flow.error === undefined ? {} : { error: flow.error }),
  } satisfies AuthFlowState as AuthFlowState;
}

function toPromptInfo(id: string, prompt: AuthPrompt): AuthPromptInfo {
  return {
    id,
    type: prompt.type,
    message: prompt.message,
    ...("placeholder" in prompt && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.type === "select"
      ? {
          options: prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }
      : {}),
  } satisfies AuthPromptInfo as AuthPromptInfo;
}

function notifyWaiters(flow: FlowRecord): void {
  flow.version += 1;
  flow.updatedAt = Date.now();
  for (const wake of [...flow.waiters]) wake();
}

function waitForChange(
  flow: FlowRecord,
  fromVersion: number,
  timeoutMs: number,
  signal?: AbortSignal,
  until?: (flow: FlowRecord) => boolean,
): Promise<void> {
  const ready = () => (until ? until(flow) : flow.version !== fromVersion || isTerminal(flow.status));
  if (ready() || timeoutMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      flow.waiters.delete(onUpdate);
      signal?.removeEventListener("abort", onAbort);
    };
    const onUpdate = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    flow.waiters.add(onUpdate);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createAuthManager(options: {
  models: ModelEnvironment;
  durableStore: DurableCredentialStore;
  providers?: readonly Provider[];
  environment?: Readonly<Record<string, string>>;
  activeFlowTtlMs?: number;
}): AuthManager {
  const { models, durableStore, providers = [], environment, activeFlowTtlMs = ACTIVE_FLOW_TTL_MS } = options;
  const flows = new Map<string, FlowRecord>();
  let closed = false;

  const finishResources = (flow: FlowRecord): void => {
    if (flow.timeoutTimer !== undefined) {
      clearTimeout(flow.timeoutTimer);
      flow.timeoutTimer = undefined;
    }
    flow.release();
  };

  const cancelFlow = (flow: FlowRecord, reason: string, now = Date.now()): void => {
    if (isTerminal(flow.status)) return;
    flow.status = "canceled";
    flow.error = reason;
    flow.settledAt = now;
    const pending = flow.pending;
    flow.pending = undefined;
    finishResources(flow);
    flow.abort.abort(new SignInCancelled(reason));
    pending?.reject(new SignInCancelled(reason));
    notifyWaiters(flow);
  };

  const prune = (now = Date.now()): void => {
    for (const [id, flow] of flows) {
      if (flow.settledAt !== undefined) {
        if (now - flow.settledAt >= SETTLED_FLOW_TTL_MS) flows.delete(id);
      } else if (now - flow.startedAt >= activeFlowTtlMs) {
        cancelFlow(flow, "login flow timed out", now);
        flows.delete(id);
      }
    }
  };

  const activeCount = (): number => {
    let count = 0;
    for (const flow of flows.values()) if (!isTerminal(flow.status)) count += 1;
    return count;
  };

  const resolveProviderAndMethod = (request: StartAuthLoginRequest): { provider: Provider; method: AuthMethod } => {
    const all = loginProviders(providers);
    const needle = request.provider.trim().toLowerCase();
    const provider = all.find((p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle);
    if (provider === undefined) {
      throw agentError("not_found", `unknown provider "${request.provider}"`);
    }
    const methods: AuthMethod[] = [];
    if (interactiveAuth(provider, "oauth")?.login) methods.push("oauth");
    if (interactiveAuth(provider, "api_key")?.login) methods.push("api_key");
    if (methods.length === 0) {
      throw agentError("invalid_request", `provider "${provider.id}" has no interactive login`);
    }
    if (request.method !== undefined) {
      if (!methods.includes(request.method)) {
        throw agentError(
          "invalid_request",
          `provider "${provider.id}" does not support "${request.method}" login (available: ${methods.join(", ")})`,
        );
      }
      return { provider, method: request.method };
    }
    if (methods.length > 1) {
      throw agentError(
        "invalid_request",
        `provider "${provider.id}" supports multiple login methods (${methods.join(", ")}): pass method`,
      );
    }
    return { provider, method: methods[0] as AuthMethod };
  };

  return {
    async providers(): Promise<AuthProviderStatus[]> {
      prune();
      const all = loginProviders(providers);
      const list = await Promise.all(
        all.map(async (provider): Promise<AuthProviderStatus> => {
          const methods: AuthMethod[] = [];
          if (interactiveAuth(provider, "oauth")?.login) methods.push("oauth");
          if (interactiveAuth(provider, "api_key")?.login) methods.push("api_key");
          const [status, durable] = await Promise.all([models.authStatus(provider.id), durableStore.read(provider.id)]);
          return {
            provider: provider.id,
            name: provider.name,
            methods,
            authenticated: status.source !== undefined,
            ...(status.source === undefined ? {} : { source: status.source }),
            ...(durable === undefined ? {} : { stored: durable.type }),
            ...(status.error === undefined ? {} : { error: status.error }),
          } satisfies AuthProviderStatus as AuthProviderStatus;
        }),
      );
      return list.sort((a, b) => a.name.localeCompare(b.name));
    },

    async startLogin(request, startOptions): Promise<AuthFlowState> {
      if (closed) throw agentError("unavailable", "the agent is closing");
      prune();
      if (activeCount() >= MAX_ACTIVE_FLOWS) {
        throw agentError("busy", "too many authentication flows are already in flight", { reason: "capacity" });
      }
      const { provider, method } = resolveProviderAndMethod(request);
      const now = Date.now();
      const doneWork = beginWork();
      let released = false;
      const flow: FlowRecord = {
        flowId: randomUUID(),
        provider: provider.id,
        method,
        abort: new AbortController(),
        startedAt: now,
        release: () => {
          if (released) return;
          released = true;
          doneWork();
        },
        updatedAt: now,
        version: 0,
        status: "pending",
        messages: [],
        waiters: new Set(),
      };
      flow.timeoutTimer = setTimeout(() => {
        cancelFlow(flow, "login flow timed out");
      }, activeFlowTtlMs);
      flow.timeoutTimer.unref?.();
      flows.set(flow.flowId, flow);

      const pushMessage = (text: string): void => {
        flow.messages.push(text);
        if (flow.messages.length > MAX_MESSAGES) flow.messages.shift();
      };

      void loginOver(
        {
          provider: provider.id,
          method,
          store: durableStore,
          resolveDeviceId: () => durableStore.getOrCreateDeviceId(),
          interaction: {
            signal: flow.abort.signal,
            notify(event: AuthEvent) {
              if (event.type === "auth_url") {
                flow.authUrl = {
                  url: event.url,
                  ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
                };
              } else if (event.type === "device_code") {
                flow.deviceCode = {
                  userCode: event.userCode,
                  verificationUri: event.verificationUri,
                  ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
                  ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
                };
              } else {
                pushMessage(event.message);
              }
              notifyWaiters(flow);
            },
            prompt(prompt: AuthPrompt) {
              return new Promise<string>((resolve, reject) => {
                const promptId = randomUUID();
                const info = toPromptInfo(promptId, prompt);
                const onAbort = () => {
                  if (flow.pending?.info.id === promptId) {
                    flow.pending = undefined;
                    if (!isTerminal(flow.status)) flow.status = "pending";
                    notifyWaiters(flow);
                  }
                  reject(prompt.signal?.reason ?? new SignInCancelled("cancelled"));
                };
                if (prompt.signal?.aborted) {
                  reject(prompt.signal.reason);
                  return;
                }
                prompt.signal?.addEventListener("abort", onAbort, { once: true });
                flow.pending = {
                  info,
                  resolve: (value) => {
                    prompt.signal?.removeEventListener("abort", onAbort);
                    resolve(value);
                  },
                  reject: (error) => {
                    prompt.signal?.removeEventListener("abort", onAbort);
                    reject(error);
                  },
                };
                flow.status = "awaiting_input";
                notifyWaiters(flow);
              });
            },
          },
        },
        {
          providers,
          ...(environment === undefined ? {} : { environment }),
        },
      ).then(
        (result) => {
          if (isTerminal(flow.status)) return;
          flow.pending = undefined;
          flow.status = "completed";
          flow.verified = result.verified;
          flow.settledAt = Date.now();
          finishResources(flow);
          notifyWaiters(flow);
        },
        (error: unknown) => {
          if (isTerminal(flow.status)) return;
          flow.pending = undefined;
          if (error instanceof SignInCancelled || flow.abort.signal.aborted) {
            flow.status = "canceled";
            flow.error = flow.error ?? "login cancelled";
          } else {
            flow.status = "failed";
            flow.error = error instanceof Error ? error.message : String(error);
          }
          flow.settledAt = Date.now();
          finishResources(flow);
          notifyWaiters(flow);
        },
      );

      await waitForChange(
        flow,
        0,
        INITIAL_WAIT_MS,
        startOptions?.signal,
        (current) =>
          isTerminal(current.status) ||
          current.pending !== undefined ||
          current.authUrl !== undefined ||
          current.deviceCode !== undefined,
      );
      return snapshotOf(flow);
    },

    async getLogin(flowId, getOptions = {}): Promise<AuthFlowState> {
      prune();
      const flow = flows.get(flowId);
      if (flow === undefined) throw agentError("not_found", `no auth login flow "${flowId}"`);
      if (getOptions.wait !== undefined && getOptions.wait > 0 && !isTerminal(flow.status)) {
        await waitForChange(flow, flow.version, getOptions.wait * 1000, getOptions.signal);
      }
      return snapshotOf(flow);
    },

    async submitInput(flowId, input: AuthLoginInput, submitOptions): Promise<AuthFlowState> {
      prune();
      const flow = flows.get(flowId);
      if (flow === undefined) throw agentError("not_found", `no auth login flow "${flowId}"`);
      if (flow.pending === undefined || flow.status !== "awaiting_input") {
        throw agentError("invalid_request", `auth login flow "${flowId}" is not waiting for input`);
      }
      if (flow.pending.info.id !== input.promptId) {
        throw agentError("invalid_request", `promptId "${input.promptId}" does not match the active prompt`);
      }
      const pending = flow.pending;
      const before = flow.version;
      flow.pending = undefined;
      flow.status = "pending";
      notifyWaiters(flow);
      pending.resolve(input.value);

      await waitForChange(
        flow,
        before + 1,
        SUBMIT_WAIT_MS,
        submitOptions?.signal,
        (current) => isTerminal(current.status) || current.pending !== undefined,
      );
      return snapshotOf(flow);
    },

    async cancelLogin(flowId): Promise<void> {
      prune();
      const flow = flows.get(flowId);
      if (flow === undefined) throw agentError("not_found", `no auth login flow "${flowId}"`);
      cancelFlow(flow, "login cancelled");
    },

    async logout(provider): Promise<{ removed: boolean }> {
      prune();
      const all = loginProviders(providers);
      const needle = provider.trim().toLowerCase();
      const resolved =
        all.find((p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle)?.id ?? provider;
      const existing = await durableStore.read(resolved);
      if (existing === undefined) return { removed: false };
      await durableStore.delete(resolved);
      return { removed: true };
    },

    close(): void {
      closed = true;
      for (const flow of flows.values()) {
        cancelFlow(flow, "agent closed");
      }
      flows.clear();
    },
  };
}
