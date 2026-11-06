/** The product, as one call: an opened agent becomes a live service, its channels, schedules and wake-ups. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { Agent } from "./agent-api.ts";
import type { ChannelHandler, LongConnection, Routes } from "./channel.ts";
import {
  type AnyChannelModule,
  type LoadedLongConnectionChannel,
  channelIngress,
  mountChannels,
} from "./channels/discover.ts";
import { parseRouteKey, router } from "./channels/router.ts";
import { serveHandler, totalFetch } from "./channels/serve.ts";
import {
  type WebhookKind,
  type WebhookRegistration,
  pendingWebhooks,
  registerOwnWebhooks,
  webhookKinds,
  webhookPath,
} from "./channels/webhooks.ts";
import { addressedTo, onReached, readReached } from "./channels/webhook-evidence.ts";
import { channelStateDir } from "./channels/context.ts";
import { portCleanup } from "./effect-port.ts";
import { API_PREFIX } from "./http/contract.ts";
import { apiHandler, isApiPath } from "./http/server.ts";
import { log } from "./log.ts";
import { once } from "./once.ts";
import { type Scheduler, createScheduler } from "./schedule/scheduler.ts";
import type { Schedule } from "./schedule/schedule.ts";
import { servedByDev } from "./serving-command.ts";

export type { WebhookRegistration } from "./channels/webhooks.ts";

/** Default wait for a channel's `closed` before reporting it stuck. */
const CLOSE_DEADLINE_MS = 5_000;

/** One deadline for all connections; a failed close must not hide a sibling that is still running. */
function closeWithin(
  runs: readonly LongConnection[],
  names: readonly string[],
  deadlineMs: number,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const pending = new Set(runs.map((_, i) => i));
    const failures: unknown[] = [];
    yield* Effect.forEach(
      runs,
      (run, i) =>
        Effect.tryPromise({ try: () => run.closed, catch: (error) => error }).pipe(
          Effect.match({
            onSuccess: () => {
              pending.delete(i);
            },
            onFailure: (error) => {
              pending.delete(i);
              failures.push(error);
            },
          }),
        ),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.void }));
    if (pending.size > 0) {
      const stuck = [...pending].map((i) => names[i] ?? "channel");
      return yield* Effect.fail(
        new Error(`long connection(s) did not stop within ${deadlineMs}ms: ${stuck.join(", ")}`),
      );
    }
    if (failures.length > 0) {
      return yield* Effect.fail(
        failures.length === 1 ? failures[0] : new AggregateError(failures, "long connections failed to close"),
      );
    }
  });
}

/** The port a serve binds when neither a flag, `PORT` (start only) nor `http.port` names one. */
export const DEFAULT_HTTP_PORT = 8787;

/** What a serve answers: its channels' routes, and `GET /health` unless a channel serves it. */
interface ServingSurface {
  routes: Routes;
  longConnections: LoadedLongConnectionChannel[];
  /** Route-channel names; the tunnel registers only this subset. */
  routeChannels: string[];
  /** Flip health between 200 and 503. */
  setReady(value: boolean): void;
}

/**
 * Mount the channels and the health check: JSON, `{ status, webhooks }`, each webhook channel only by name and outcome
 * (SPEC.md §9.1), since it is public; a step and its reasons are in the log.
 */
export function routesFor(
  agent: Agent,
  stateRoot: string,
  channels: ReadonlyMap<string, AnyChannelModule>,
  webhooks: () => readonly WebhookRegistration[] = () => [],
): ServingSurface {
  const { routes, longConnections, routeChannels } = mountChannels(channels, agent, stateRoot);
  for (const key of Object.keys(routes)) {
    if (isApiPath(parseRouteKey(key).path)) {
      throw new Error(`route "${key}" is under ${API_PREFIX}, which the Agent API serves — move it`);
    }
  }
  let ready = longConnections.length === 0;
  const health = (): Response =>
    Response.json(
      {
        status: ready ? "ok" : "starting",
        webhooks: webhooks().map(({ channel, outcome }) => ({ channel, outcome })),
      },
      { status: ready ? 200 : 503 },
    );
  const probed = Object.keys(routes).some((key) => {
    const entry = parseRouteKey(key);
    return entry.path === "/health" && (entry.method === undefined || entry.method === "GET");
  });
  return {
    // A probe is the deployment's to shape, so a channel may serve `/health` itself.
    routes: probed ? routes : { ...routes, "GET /health": health },
    longConnections,
    routeChannels,
    setReady(value: boolean) {
      ready = value;
    },
  };
}

/** Start the clock: the definition's schedules, and the wake-ups the agent sets for itself, on every serve. */
export function startSchedules(
  agent: Agent,
  stateRoot: string,
  schedules: readonly Schedule[],
  options: { localClock?: boolean } = {},
): Pick<Scheduler, "stop"> {
  const scheduler = Effect.runSync(
    createScheduler({
      agent,
      stateRoot,
      schedules,
      ...(options.localClock === false ? { localClock: false } : {}),
    }),
  );
  scheduler.start();
  if (schedules.length > 0) log.info(`[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}`);
  return scheduler;
}

/** What `serve()` answers (SPEC.md §8): the agent's channels, schedules and wake-ups, and `GET /health`. */
export interface Service {
  /** For an app's own server to route to. */
  fetch(request: Request): Promise<Response>;
  /**
   * Or a server of its own, on this runtime's server: the one way to start one. Answers the port it bound. Once the
   * serve is ready it registers the webhook channels at `http.publicUrl`, in the background (`webhooks`).
   */
  listen(port: number, host?: string): Promise<number>;
  /**
   * Point each webhook channel's platform at `<baseUrl ?? http.publicUrl>/<its path>`, for an app serving `fetch` on its
   * own server, once that server answers and the serve is ready: set on every call. Answers every webhook channel's
   * outcome; rejects only for a `baseUrl` that is not an absolute http(s) URL.
   */
  registerWebhooks(baseUrl?: string): Promise<WebhookRegistration[]>;
  /** Every webhook channel's outcome, `pending` until its registration ends; empty only with no webhook channel. */
  readonly webhooks: readonly WebhookRegistration[];
  /** Settles when every long connection is up: immediately when there are none. */
  ready: Promise<void>;
  /**
   * Stop the server, giving the requests in flight a moment before ending them, then long connections and schedules.
   * It does NOT drain the agent's messages: one takes seconds to minutes, and the deployment wants the old process gone
   * in under a second. What makes that safe is that they are durable: an accepted message is answered after the
   * restart, and a chat turn's intent is durable before it is accepted (`channels/kit/turn-store.ts`). A schedule
   * fire's claim is written before its message: the next boot writes back the end of a message the agent took, and
   * records one it never took as `interrupted`.
   */
  close(): Promise<void>;
}

/** A serve as the CLI reports it: what it serves, beside the Service itself. */
export interface ServedAgent extends Service {
  /** The literal routes the service answers, for a startup line naming them. */
  routes: Routes;
  agentDir: string;
  /** What actually mounted: channels serving routes, and long connections. */
  channels: { routes: string[]; longConnections: string[] };
  schedules: readonly Schedule[];
  /** Whether the Agent API is served, under `/v1`: only with a key (SPEC.md §9.1). */
  api: boolean;
}

/** A serve's webhook channels: their outcomes, and the registration that sets them, one at a time. */
export interface WebhookRegistry {
  /** The outcomes, as one array kept current. */
  list(): readonly WebhookRegistration[];
  register(baseUrl?: string): Promise<WebhookRegistration[]>;
  /** Stop hearing the platforms reach it. */
  dispose(): void;
}

/** The channels whose platform lets only a person set the URL (SPEC.md §8): Slack, and Lark without its config API. */
const PERSON_SET: readonly WebhookKind[] = ["slack", "lark"];

/** Where a channel's URL a person set is confirmed: its state (what reached it), and its binding's recorded `url`. */
interface Confirmation {
  stateDir(kind: WebhookKind): string;
  appUrl(kind: WebhookKind): string | undefined;
}

/** Nothing to point: a serve with no webhook channel. */
const NONE: readonly WebhookRegistration[] = Object.freeze([]);
const NO_WEBHOOKS: WebhookRegistry = { list: () => NONE, register: async () => [], dispose: () => {} };

/**
 * The webhook channels among `kinds`, registered with `env`, the instance's own secrets, at `publicUrl` unless a call
 * names another base. Each call waits for the one before it, so two never interleave their platform calls.
 */
function webhookRegistry(
  kinds: readonly WebhookKind[],
  env: NodeJS.ProcessEnv,
  publicUrl: string | undefined,
  confirmation: Confirmation,
  options: { attempts?: number; retryMs?: number } = {},
): WebhookRegistry {
  // One array, replaced in place: a Service is spread into the objects that extend it, and each keeps reading this.
  const current: WebhookRegistration[] = pendingWebhooks(kinds);
  const replace = (next: readonly WebhookRegistration[]) => current.splice(0, current.length, ...next);
  let previous: Promise<unknown> = Promise.resolve();
  let base: string | undefined;
  // A URL only a person sets is confirmed by the platform reaching it: told as it happens, or read from the record.
  const confirmed = (kind: WebhookKind, address: string | undefined, at: string): boolean => {
    const path = webhookPath(kind);
    if (confirmation.appUrl(kind) === `${at}${path}`) return true;
    if (address === undefined) return false;
    if (addressedTo(address, at, path)) return true;
    log.warn(`[fastagent] ${kind}: the platform reached this instance at ${address}, not ${at}${path}`);
    return false;
  };
  const confirm = (registrations: WebhookRegistration[], at: string | undefined) =>
    registrations.map((entry) => {
      const kind = entry.channel as WebhookKind;
      if (at === undefined || entry.outcome !== "manual" || !PERSON_SET.includes(kind)) return entry;
      if (!confirmed(kind, readReached(confirmation.stateDir(kind)), at)) return entry;
      return { channel: entry.channel, outcome: "registered" as const, url: `${at}${webhookPath(kind)}` };
    });
  const stops = kinds
    .filter((kind) => PERSON_SET.includes(kind))
    .map((kind) =>
      onReached(confirmation.stateDir(kind), (address) => {
        const index = current.findIndex((entry) => entry.channel === kind);
        const entry = current[index];
        if (base === undefined || entry?.outcome !== "manual" || !confirmed(kind, address, base)) return;
        current[index] = { channel: kind, outcome: "registered", url: `${base}${webhookPath(kind)}` };
      }),
    );
  return {
    list: () => current,
    register(baseUrl) {
      if (baseUrl !== undefined && !/^https?:\/\/[^/?#\s]+/.test(baseUrl)) {
        return Promise.reject(new Error(`registerWebhooks: ${JSON.stringify(baseUrl)} is not an absolute http(s) URL`));
      }
      const at = (baseUrl ?? publicUrl)?.replace(/\/+$/, "");
      const run = previous.then(async () => {
        base = at;
        replace(pendingWebhooks(kinds));
        if (at === undefined && kinds.length > 0 && !servedByDev()) {
          log.info(`[fastagent] webhooks: no http.publicUrl, so nothing points ${kinds.join(", ")} at this instance`);
        }
        replace(confirm(await registerOwnWebhooks(at, kinds, env, options), at));
        return [...current];
      });
      previous = run.catch(() => {});
      return run;
    },
    dispose: () => {
      for (const stop of stops) stop();
    },
  };
}

/** The webhook channels of an opened agent, to be pointed at `http.publicUrl` or at a URL the host names. */
export function webhooksOf(opened: ServableAgent): WebhookRegistry {
  const kinds = webhookKinds([...opened.channels].map(([name, module]) => ({ name, ingress: channelIngress(module) })));
  return webhookRegistry(kinds, opened.secrets, opened.config.http?.publicUrl, {
    stateDir: (kind) => channelStateDir(opened.stateRoot, kind),
    appUrl: (kind) => opened.config.channels?.[kind]?.app?.url,
  });
}

/**
 * A Service over `handler`: answered in process, or served on a server of its own. `endStreams` ends what would hold
 * the server's close open (a Caller watching events), and `shutdown` stops the rest once the server has.
 */
export function serviceOver(
  handler: ChannelHandler,
  ready: Promise<void>,
  shutdown: () => Promise<void>,
  endStreams: () => Promise<void> = async () => {},
  webhooks: WebhookRegistry = NO_WEBHOOKS,
): Service {
  let listener: ReturnType<typeof serveHandler> | undefined;
  let closing: Promise<void> | undefined;
  const fetch = totalFetch(handler);
  return {
    fetch,
    registerWebhooks: (baseUrl) =>
      closing !== undefined ? Promise.reject(new Error("the service is closed")) : webhooks.register(baseUrl),
    webhooks: webhooks.list(),
    listen(port, host) {
      if (closing !== undefined) return Promise.reject(new Error("the service is closed"));
      if (listener !== undefined) return Promise.reject(new Error("the service is already listening"));
      const current = serveHandler(handler, { port, ...(host === undefined ? {} : { host }) });
      listener = current;
      return current.listening.then(
        (bound) => {
          // After ready: a host may route to the instance only once its health check passes, and a platform verifies
          // the URL as it is set. In the background, so the port is answered without waiting for a platform.
          // A ready that fails is the failure its awaiter reports: nothing is registered for a serve that never was.
          void ready.then(
            () =>
              closing === undefined
                ? webhooks
                    .register()
                    .catch((error: unknown) => log.error(`[fastagent] webhook registration failed: ${String(error)}`))
                : undefined,
            () => {},
          );
          return bound;
        },
        async (error: unknown) => {
          // A bind that failed holds nothing once its scope is closed, so the service may listen again, elsewhere.
          if (listener === current) listener = undefined;
          await current.close();
          throw error;
        },
      );
    },
    ready,
    close() {
      closing ??= (async () => {
        // The server first, so nothing new reaches what stops after it; each step runs, and every failure is said.
        const failures: unknown[] = [];
        for (const step of [endStreams, () => listener?.close(), shutdown, webhooks.dispose]) {
          await Promise.resolve()
            .then(step)
            .catch((error: unknown) => failures.push(error));
        }
        if (failures.length > 0) {
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, "the service did not close cleanly");
        }
      })();
      return closing;
    },
  };
}

/** What {@link serveAgent} needs beyond an opened agent. */
export interface ServeOptions {
  /** Called when a long connection ends on its own — a dropped socket-mode channel, say. */
  onChannelClosed?: (name: string, error?: unknown) => void;
  /** How long `close()` waits for a channel to stop before reporting it stuck (default 5s). */
  closeTimeoutMs?: number;
  /** The keys the Agent API takes; without one it is not served (SPEC.md §9.1). */
  apiKeys?: readonly string[];
}

/** What the assembly serves. */
export interface ServableAgent {
  agent: Agent;
  /** The instance's secrets: what its webhook channels are pointed with. */
  secrets: Readonly<Record<string, string>>;
  /** The configuration's part a serve reads: where the platforms reach it, and the URLs a person set there. */
  config: { http?: { publicUrl?: string }; channels?: Readonly<Record<string, { app?: { url?: string } }>> };
  /** The project directory the instance's `.secrets/` belong to. */
  agentDir: string;
  /** Where durable state lives (channel state, schedule fires, wake-ups). */
  stateRoot: string;
  channels: ReadonlyMap<string, AnyChannelModule>;
  schedules: readonly Schedule[];
}

/** The assembly itself: channels, schedules and long connections, composed into one handler. */
export async function serveAgent(opened: ServableAgent, options: ServeOptions = {}): Promise<ServedAgent> {
  const { agent, agentDir, stateRoot, schedules } = opened;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_DEADLINE_MS;
  const webhooks = webhooksOf(opened);
  const routed = routesFor(agent, stateRoot, opened.channels, webhooks.list);
  // Composed BEFORE anything starts.
  const channels = router(routed.routes);
  const api = options.apiKeys?.length ? apiHandler(agent, { keys: options.apiKeys }) : undefined;
  const handler: ChannelHandler =
    api === undefined ? channels : (req) => (isApiPath(new URL(req.url).pathname) ? api.fetch(req) : channels(req));
  return Effect.runPromise(
    Effect.gen(function* () {
      const lifetime = yield* Scope.make();
      const abort = new AbortController();
      const runs: LongConnection[] = [];
      const names = routed.longConnections.map((c) => c.name);
      // A connection lost during startup must not be hidden by a sibling becoming ready later.
      let dropped = false;
      const onClosed =
        options.onChannelClosed ??
        ((name, error) =>
          log.error(
            `[fastagent] long connection ${name} ${error === undefined ? "closed" : `failed: ${String(error)}`}`,
          ));
      const notifyClosed = (name: string, error?: unknown): void => {
        if (abort.signal.aborted) return;
        dropped = true;
        routed.setReady(false);
        onClosed(name, error);
      };

      // Scope.close alone does not join concurrent closes or retain their failure. Every later call, the rollback a
      // close itself triggers included, awaits the first one's outcome.
      const shutdown = once(
        Effect.gen(function* () {
          abort.abort();
          yield* Scope.close(lifetime, Exit.void);
        }),
      );
      const close = (): Promise<void> => Effect.runPromise(shutdown);
      const rollback = shutdown.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.error(`[fastagent] cleanup after a failed start also failed: ${String(Cause.squash(cause))}`),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        if (api !== undefined) yield* Effect.addFinalizer(() => portCleanup("closing the Agent API", api.dispose));
        // Registered first, so subscriptions and schedule timers stop before waiting for transports.
        yield* Effect.addFinalizer(() => closeWithin(runs, names, closeTimeoutMs).pipe(Effect.orDie));
        yield* Effect.acquireRelease(
          Effect.try({
            try: () => startSchedules(agent, stateRoot, schedules),
            catch: (error) => error,
          }),
          (scheduled) => Effect.sync(scheduled.stop),
        );
        const readiness = yield* Effect.forEach(routed.longConnections, (connection) =>
          Effect.gen(function* () {
            const run = yield* Effect.try({
              try: () => connection.connect(abort.signal),
              catch: (error) => error,
            });
            if (typeof run?.ready?.then !== "function" || typeof run?.closed?.then !== "function") {
              return yield* Effect.fail(
                new Error(`${connection.name} connect(signal) must return { ready: Promise, closed: Promise }`),
              );
            }
            runs.push(run);
            const closed = Effect.tryPromise({ try: () => run.closed, catch: (error) => error });
            yield* closed.pipe(
              Effect.match({
                onSuccess: () => notifyClosed(connection.name),
                onFailure: (error) => notifyClosed(connection.name, error),
              }),
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error(`[fastagent] channel closure callback failed: ${String(Cause.squash(cause))}`),
                ),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            // Observe ready immediately, including when a later connect() throws and mount rolls back.
            return yield* Effect.raceFirst(
              Effect.tryPromise({ try: () => run.ready, catch: (error) => error }),
              closed.pipe(
                Effect.matchEffect({
                  onSuccess: () => Effect.fail(new Error(`${connection.name} closed before it was ready`)),
                  onFailure: (error) =>
                    Effect.fail(new Error(`${connection.name} failed before it was ready: ${String(error)}`)),
                }),
              ),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (!abort.signal.aborted) log.info(`[fastagent] long connection ready: ${connection.name}`);
                }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
          }),
        );

        // The public readiness waiter lives outside the scope it may roll back.
        const ready = Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.forEach(readiness, Fiber.join, { concurrency: "unbounded", discard: true });
            if (abort.signal.aborted) return yield* Effect.fail(new Error("service closed before it became ready"));
            if (dropped) return yield* Effect.fail(new Error("a long connection closed before startup completed"));
            routed.setReady(true);
          }).pipe(
            Effect.catchCause((cause) =>
              abort.signal.aborted
                ? Effect.fail(new Error("service closed before it became ready"))
                : Effect.failCause(cause),
            ),
            Effect.onError(() => rollback),
          ),
        );
        // The rejection is still delivered to callers that await ready.
        ready.catch(() => {});

        return {
          ...serviceOver(handler, ready, close, async () => api?.endStreams(), webhooks),
          routes: routed.routes,
          agentDir,
          channels: { routes: routed.routeChannels, longConnections: names },
          schedules,
          api: api !== undefined,
        };
      }).pipe(
        Scope.provide(lifetime),
        Effect.onError(() => rollback),
      );
    }),
  );
}
