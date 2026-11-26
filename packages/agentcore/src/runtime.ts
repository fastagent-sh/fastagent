/**
 * An agent as an AgentCore runtime. AgentCore gives each session a microVM of its own, and a session is one instance:
 * named by the session id AgentCore puts on every invocation, and kept in the database, so a microVM holds nothing that
 * must survive. The first invocation opens the instance; one naming another session is refused, since this microVM is
 * that one's.
 *
 * The Agent API is served as it is everywhere, behind a key this process makes and adds to each request it unwraps:
 * what reaches the container came through AgentCore, which authenticated it (IAM or JWT), so a second credential would
 * only be one more for a Caller to hold.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { HttpEffect, HttpServer } from "effect/http";
import { type ErrorCode, agentError, errorData } from "@fastagent-sh/client/agent-api";
import { statusOf } from "@fastagent-sh/client/http/contract";
import {
  type AgentDefinition,
  type LocalAgent,
  type OpenAgentOptions,
  type PostgresDatabase,
  type Service,
  openAgent,
} from "@fastagent-sh/fastagent";
import { Unavailable } from "@fastagent-sh/fastagent/platform";
import { type EnvelopedRequest, envelopeResponse, isEventStream } from "./contract.ts";

/** The header AgentCore names an invocation's session in. */
export const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

/** AgentCore's HTTP protocol: the port its invocations and `/ping` reach. */
const PORT = 8080;

export interface AgentCoreOptions extends Pick<OpenAgentOptions, "secrets" | "env" | "model" | "harness" | "sandbox"> {
  /**
   * Where the instances are: on AWS, `dsqlDatabase(...)`. Or how to find it as an instance opens, so a runtime without
   * one says so to every invocation rather than exiting where only its log tells.
   */
  database: PostgresDatabase | (() => PostgresDatabase);
  /** The agent's working directory, on the microVM's disk: gone with it. Default `/tmp/fastagent`. */
  root?: string;
  /**
   * The agent's values read where they are kept (its Secrets Manager secret), over `secrets`: read as the instance
   * opens, so one that cannot be read is said to the invocation, and one fixed after the deploy is read at the next.
   */
  values?: () => Promise<Readonly<Record<string, string | Redacted.Redacted<string>>>>;
}

interface Opened {
  readonly agent: LocalAgent;
  readonly service: Service;
  readonly key: Redacted.Redacted<string>;
  readonly scope: Scope.Closeable;
}

type SlotState =
  | { readonly _tag: "empty" }
  | { readonly _tag: "opening"; readonly name: string; readonly ready: Deferred.Deferred<Opened, OpenFailure> }
  | { readonly _tag: "open"; readonly name: string; readonly opened: Opened }
  | { readonly _tag: "closed"; readonly done: Deferred.Deferred<void, never> };

class OpenFailure {
  readonly _tag = "OpenFailure";
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

class WrongSessionFailure {
  readonly _tag = "WrongSessionFailure";
  readonly active: string;
  constructor(active: string) {
    this.active = active;
  }
}

/** A refusal as the Agent API answers it, inside the envelope AgentCore delivers whole. */
function refused(code: ErrorCode, message: string): Promise<Response> {
  const error = errorData(agentError(code, message));
  const answer = Response.json(
    { error },
    { status: statusOf(error), headers: code === "unavailable" ? { "retry-after": "1" } : {} },
  );
  return enveloped(answer);
}

async function enveloped(response: Response): Promise<Response> {
  // An event stream goes out as it is written: AgentCore passes a 200 with its body through.
  if (response.status === 200 && isEventStream(response.headers.get("content-type"))) return response;
  return Response.json({ response: await envelopeResponse(response) });
}

function parseRequest(body: unknown): EnvelopedRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const request = (body as { request?: Partial<EnvelopedRequest> }).request;
  if (typeof request?.method !== "string" || typeof request.path !== "string" || !request.path.startsWith("/")) {
    return undefined;
  }
  if (request.body !== undefined && typeof request.body !== "string") return undefined;
  return {
    method: request.method,
    path: request.path,
    headers: request.headers ?? {},
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}

/** Close a scope quietly so a finalizer failure never masks the caller's error. */
function closeScopeQuietly(scope: Scope.Closeable, label: string): Effect.Effect<void> {
  return Scope.close(scope, Exit.void).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => console.error(`[fastagent] ${label} cleanup failed: ${String(Cause.squash(cause))}`)),
    ),
  );
}

/** What the container answers, as a Fetch handler: `/ping` and `POST /invocations`. */
export function agentCoreHandler(definition: AgentDefinition, options: AgentCoreOptions) {
  const { database, root = "/tmp/fastagent", values, ...given } = options;
  const slot = Ref.makeUnsafe<SlotState>({ _tag: "empty" });

  const placedDatabase = (): PostgresDatabase => (typeof database === "function" ? database() : database);

  const openInstance = Effect.fn("agentcore.openInstance")(function* (name: string) {
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const scope = yield* Scope.make();
    return yield* Effect.gen(function* () {
      const extra =
        values === undefined ? {} : yield* Effect.tryPromise({ try: values, catch: (cause) => new OpenFailure(cause) });
      const secrets = { ...given.secrets, ...extra };
      const placed = yield* Effect.try({ try: placedDatabase, catch: (cause) => new OpenFailure(cause) });
      const agent = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => openAgent(definition, { ...given, secrets, root, name, database: placed }),
          catch: (cause) => new OpenFailure(cause),
        }),
        (openedAgent) =>
          Effect.promise(() =>
            openedAgent.close().catch((error: unknown) => {
              console.error(`[fastagent] closing "${name}" failed: ${String(error)}`);
            }),
          ),
      );
      const key = Redacted.make(randomBytes(32).toString("base64url"));
      const service = yield* Effect.tryPromise({
        try: () => agent.serve({ apiKeys: [key] }),
        catch: (cause) => new OpenFailure(cause),
      });
      const opened: Opened = { agent, service, key, scope };
      // Its runs stopped under it (the lease went to another process, or went unrenewed): clear the slot and close
      // the instance scope so the next invocation opens the instance cleanly.
      const reopen = () => {
        void runPromise(
          Ref.modify(slot, (current) =>
            current._tag === "open" && current.opened === opened
              ? ([true, { _tag: "empty" }] as const)
              : ([false, current] as const),
          ).pipe(
            Effect.flatMap((shouldClose) =>
              shouldClose ? closeScopeQuietly(scope, `closing "${name}"`) : Effect.void,
            ),
          ),
        );
      };
      agent.closed?.then(reopen, reopen);
      return opened;
    }).pipe(
      Scope.provide(scope),
      Effect.onError(() => closeScopeQuietly(scope, `rolling back "${name}"`)),
    );
  });

  const openSession = Effect.fn("agentcore.openSession")(function* (name: string) {
    const decision = yield* Ref.modify(
      slot,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "ready"; readonly opened: Opened }
          | { readonly _tag: "wrong"; readonly active: string }
          | { readonly _tag: "closed" }
          | { readonly _tag: "wait"; readonly ready: Deferred.Deferred<Opened, OpenFailure> }
          | { readonly _tag: "leader"; readonly ready: Deferred.Deferred<Opened, OpenFailure> }
        ),
        SlotState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "closed" }, current];
        if (current._tag === "open") {
          return current.name === name
            ? [{ _tag: "ready", opened: current.opened }, current]
            : [{ _tag: "wrong", active: current.name }, current];
        }
        if (current._tag === "opening") {
          return current.name === name
            ? [{ _tag: "wait", ready: current.ready }, current]
            : [{ _tag: "wrong", active: current.name }, current];
        }
        const ready = Deferred.makeUnsafe<Opened, OpenFailure>();
        return [
          { _tag: "leader", ready },
          { _tag: "opening", name, ready },
        ];
      },
    );
    if (decision._tag === "closed") {
      return yield* Effect.fail(new OpenFailure(new Unavailable("the AgentCore runtime is closing")));
    }
    if (decision._tag === "ready") return decision.opened;
    if (decision._tag === "wrong") return yield* Effect.fail(new WrongSessionFailure(decision.active));
    if (decision._tag === "wait") return yield* Deferred.await(decision.ready);
    // Single-flight leader runs uninterruptibly so concurrent callers awaiting `decision.ready` always observe a
    // settled outcome and failed opens cleanly reset the slot to `empty`.
    const outcome = yield* Effect.uninterruptible(
      openInstance(name).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Ref.update(slot, (current): SlotState => {
            if (current._tag !== "opening" || current.ready !== decision.ready) return current;
            return Exit.isSuccess(exit) ? { _tag: "open", name, opened: exit.value } : { _tag: "empty" };
          }),
        ),
        Effect.tap((exit) => Deferred.done(decision.ready, exit)),
      ),
    );
    return yield* outcome;
  });

  const closeSlot = Effect.fn("agentcore.close")(function* () {
    const decision = yield* Ref.modify(
      slot,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "join"; readonly done: Deferred.Deferred<void, never> }
          | { readonly _tag: "lead"; readonly done: Deferred.Deferred<void, never>; readonly previous: SlotState }
        ),
        SlotState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "join", done: current.done }, current];
        const done = Deferred.makeUnsafe<void, never>();
        return [
          { _tag: "lead", done, previous: current },
          { _tag: "closed", done },
        ];
      },
    );
    if (decision._tag === "join") return yield* Deferred.await(decision.done);
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const { previous } = decision;
        if (previous._tag === "open") {
          yield* closeScopeQuietly(previous.opened.scope, `closing "${previous.name}"`);
        } else if (previous._tag === "opening") {
          const openedExit = yield* Effect.exit(Deferred.await(previous.ready));
          if (Exit.isSuccess(openedExit)) {
            yield* closeScopeQuietly(openedExit.value.scope, `closing "${previous.name}"`);
          }
        }
      }).pipe(Effect.ensuring(Deferred.succeed(decision.done, undefined))),
    );
  });

  const invocation = Effect.fn("agentcore.invocation")(function* (request: Request) {
    const name = request.headers.get(SESSION_HEADER);
    if (!name) {
      return yield* Effect.promise(() =>
        refused("invalid_request", `an invocation names its AgentCore session in ${SESSION_HEADER}`),
      );
    }
    const body = yield* Effect.promise(() => request.json().catch(() => undefined));
    const asked = parseRequest(body);
    if (asked === undefined) {
      return yield* Effect.promise(() =>
        refused("invalid_request", "an invocation is { request: { method, path, headers, body } }"),
      );
    }
    const openedExit = yield* Effect.exit(openSession(name));
    if (Exit.isFailure(openedExit)) {
      const failure = Cause.squash(openedExit.cause);
      if (failure instanceof WrongSessionFailure) {
        return yield* Effect.promise(() =>
          refused("invalid_request", `this AgentCore session is the instance "${failure.active}", not "${name}"`),
        );
      }
      const error = failure instanceof OpenFailure ? failure.cause : failure;
      console.error(`[fastagent] the instance "${name}" did not open: ${String(error)}`);
      const code = error instanceof Unavailable ? "unavailable" : "internal";
      return yield* Effect.promise(() =>
        refused(code, `the instance "${name}" did not open: ${(error as Error)?.message ?? error}`),
      );
    }
    const opened = openedExit.value;
    const headers = new Headers(asked.headers);
    headers.set("authorization", `Bearer ${Redacted.value(opened.key)}`);
    const unwrapped = new Request(new URL(asked.path, "http://agent"), {
      method: asked.method,
      headers,
      signal: request.signal,
      ...(asked.body === undefined ? {} : { body: asked.body }),
    });
    return yield* Effect.promise(async () => enveloped(await opened.service.fetch(unwrapped)));
  });

  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/ping") {
        const current = Ref.getUnsafe(slot);
        const busy = current._tag === "open" && current.opened.agent.busy() === true;
        return Response.json({ status: busy ? "HealthyBusy" : "Healthy" });
      }
      if (path === "/invocations" && request.method === "POST") return Effect.runPromise(invocation(request));
      return new Response("not found\n", { status: 404 });
    },
    /** Stop serving, then release the instance. */
    close(): Promise<void> {
      return Effect.runPromise(closeSlot());
    },
  };
}

/** Serve `definition` as an AgentCore runtime, on AgentCore's port. Answers how to stop it. */
export async function serveAgentCore(
  definition: AgentDefinition,
  options: AgentCoreOptions,
): Promise<{ close(): Promise<void> }> {
  const scope = Scope.makeUnsafe();
  const handler = agentCoreHandler(definition, options);
  const server = NodeHttpServer.layer(() => createServer({ requestTimeout: 0, headersTimeout: 60_000 }), {
    port: PORT,
    host: "0.0.0.0",
    gracefulShutdownTimeout: "500 millis",
  });
  const app = Effect.interruptible(HttpEffect.fromWebHandler(handler.fetch));
  await Effect.runPromise(
    Effect.gen(function* () {
      // Registered before the server layer so LIFO scope close stops HTTP first, then releases the instance.
      yield* Scope.addFinalizer(
        scope,
        Effect.promise(() =>
          handler.close().catch((error: unknown) => {
            console.error(`[fastagent] closing AgentCore handler failed: ${String(error)}`);
          }),
        ),
      );
      yield* Layer.buildWithScope(HttpServer.serve(app).pipe(Layer.provideMerge(server)), scope);
    }).pipe(Effect.onError(() => closeScopeQuietly(scope, "starting AgentCore"))),
  );
  console.error(`[fastagent] serving AgentCore on port ${PORT}`);
  return {
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
