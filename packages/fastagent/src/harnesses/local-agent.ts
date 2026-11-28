/**
 * Public in-process embedding facade (`openAgent` / `LocalAgent`): opens an instance via `openServing` and manages
 * the `idle | serving | served | closed` state machine for `serve()` and `close()`.
 */
import { isAbsolute, join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import type { Agent, InvokeApi } from "@fastagent-sh/client/agent-api";
import type { SecretInput, SecretValuesInput } from "../declared-secrets.ts";
import { type AgentDefinition, assertDefinition } from "../definition/definition.ts";
import { STATE_DIRNAME } from "../paths.ts";
import type { PostgresDatabase } from "../postgres.ts";
import { PromiseFailure, fromPromise, originalError } from "../promise-bridge.ts";
import { type Service, serveAgent } from "../service.ts";
import { NOT_HOSTED } from "../serving-command.ts";
import type { HarnessProvider } from "../harness.ts";
import type { HarnessName, SandboxMode } from "./define.ts";
import { openServing, runServingPromise, trackInFlightClose } from "./instance-lifecycle.ts";

/** An agent opened in this process: the Agent API, and how it is served and operated. */
export interface LocalAgent extends Agent, InvokeApi {
  /**
   * `/health` and the Agent API under `/v1` when `apiKeys` holds a key: a Fetch
   * handler, or a server of its own (`listen`).
   */
  serve(options?: ServeAgentOptions): Promise<Service>;
  /** Resolves once the instance stops serving (explicit `close()` or single-writer lease loss). */
  readonly closed?: Promise<void>;
  /** Whether the runtime is ready to accept work (false as soon as shutdown starts, before cleanup settles). */
  ready(): boolean;
  /**
   * Whether the process has work in flight (a message not yet ended or an active login flow),
   * for graceful drain and scale-to-zero liveness probes.
   */
  busy(): boolean;
  /** Close what `serve` started, then release the instance's storage. */
  close(): Promise<void>;
}

export interface ServeAgentOptions {
  /** The keys a Caller of the Agent API may present. */
  apiKeys?: readonly SecretInput[];
  /** Mount `/v1/auth/*` endpoints for remote OAuth / API-key provider sign-in. Default: false. */
  remoteAuth?: boolean;
}

export interface OpenAgentOptions {
  /** The instance root, absolute: the agent's working directory, with its state in `<root>/.state`. */
  root: string;
  /** The instance's name: one path segment. Default: the definition's, as one. */
  name?: string;
  /**
   * The values the agent's code (`needs`), its MCP servers (`${VAR}`) and its model's authentication read by name. The
   * only source of them: nothing is read from the process's environment or from a file, so pass what the agent needs
   * (`process.env` is a choice an app can make).
   */
  secrets?: SecretValuesInput;
  /**
   * The base environment of the processes the agent starts (its commands, stdio MCP servers, skill scripts). Default:
   * empty; `baseEnv(process.env)` is an app's own. The commands of the agent's declared packages come ahead on its
   * `PATH`, and the secrets the definition declares are added; nothing else of the host's reaches them.
   */
  env?: Readonly<Record<string, string>>;
  /** `"provider/modelId"`, over the definition's: what a session that names none answers with. */
  model?: string;
  /** Runtime harness override (`"pi-durable"`, `"dsh"`, another `@fastagent-sh/harness-<name>`, or a `HarnessProvider`). */
  harness?: HarnessName | HarnessProvider;
  /** OS sandbox mode override on sandbox-capable harnesses (`"workspace"`, `"read-only"`, or `"off"`). */
  sandbox?: SandboxMode;
  /**
   * PostgreSQL database for instance sessions instead of `<root>/.state/agent.sqlite`, overriding
   * `secrets.FASTAGENT_DATABASE_URL`. Requires `name` to identify the instance.
   */
  database?: PostgresDatabase;
}

function locationOf({ root }: { root: unknown }): { workdir: string; stateRoot: string } {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new Error(`root must be an absolute path, and is ${JSON.stringify(root)}`);
  }
  return { workdir: root, stateRoot: join(root, STATE_DIRNAME) };
}

/**
 * Open one instance of `definition`, the default export of an agent's package, the way `dev` and `start` do before they
 * serve: its code built with the secrets it declares, its environment and the instance's storage, which
 * one process holds at a time. Nothing reaches the agent until `serve`.
 */
export async function openAgent(definition: AgentDefinition, options: OpenAgentOptions): Promise<LocalAgent> {
  const { workdir, stateRoot } = locationOf(options);
  const opened = await openServing(assertDefinition(definition), {
    workdir,
    stateRoot,
    secrets: options.secrets ?? {},
    env: options.env ?? {},
    ownEnv: options.env ?? {},
    runsAs: NOT_HOSTED,
    ...(options.name === undefined ? {} : { name: options.name }),
    auth: "state",
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.database === undefined ? {} : { database: options.database }),
  });
  const { agent, invoker } = opened;
  type LocalAgentState =
    | { readonly _tag: "idle" }
    | { readonly _tag: "serving"; readonly ready: Deferred.Deferred<Service, PromiseFailure> }
    | { readonly _tag: "served"; readonly service: Service }
    | { readonly _tag: "closed"; readonly done: Deferred.Deferred<void, PromiseFailure> };
  const state = Ref.makeUnsafe<LocalAgentState>({ _tag: "idle" });

  const serveEffect = Effect.fn("serving.localAgent.serve")(function* (serveOptions: ServeAgentOptions = {}) {
    const decision = yield* Ref.modify(
      state,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "lead"; readonly ready: Deferred.Deferred<Service, PromiseFailure> }
          | { readonly _tag: "refused"; readonly reason: string }
        ),
        LocalAgentState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "refused", reason: "this agent is closed" }, current];
        if (current._tag !== "idle") return [{ _tag: "refused", reason: "this agent is already served" }, current];
        const ready = Deferred.makeUnsafe<Service, PromiseFailure>();
        return [
          { _tag: "lead", ready },
          { _tag: "serving", ready },
        ];
      },
    );
    if (decision._tag === "refused") {
      return yield* Effect.fail(new PromiseFailure(new Error(decision.reason)));
    }
    const outcome = yield* Effect.uninterruptible(
      fromPromise(() => serveAgent(opened, serveOptions)).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Ref.update(state, (current): LocalAgentState => {
            if (current._tag !== "serving" || current.ready !== decision.ready) return current;
            return Exit.isSuccess(exit) ? { _tag: "served", service: exit.value } : { _tag: "idle" };
          }),
        ),
        Effect.tap((exit) => Deferred.done(decision.ready, exit)),
      ),
    );
    return yield* outcome;
  });

  const closeEffect = Effect.fn("serving.localAgent.close")(function* () {
    const decision = yield* Ref.modify(
      state,
      (
        current,
      ): readonly [
        (
          | { readonly _tag: "join"; readonly done: Deferred.Deferred<void, PromiseFailure> }
          | {
              readonly _tag: "lead";
              readonly done: Deferred.Deferred<void, PromiseFailure>;
              readonly previous: LocalAgentState;
            }
        ),
        LocalAgentState,
      ] => {
        if (current._tag === "closed") return [{ _tag: "join", done: current.done }, current];
        const done = Deferred.makeUnsafe<void, PromiseFailure>();
        return [
          { _tag: "lead", done, previous: current },
          { _tag: "closed", done },
        ];
      },
    );
    if (decision._tag === "join") return yield* Deferred.await(decision.done);
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        let service: Service | undefined;
        if (decision.previous._tag === "served") {
          service = decision.previous.service;
        } else if (decision.previous._tag === "serving") {
          const servedExit = yield* Effect.exit(Deferred.await(decision.previous.ready));
          if (Exit.isSuccess(servedExit)) service = servedExit.value;
        }
        const failures: unknown[] = [];
        if (service !== undefined) {
          const serviceClose = service.close;
          const exit = yield* Effect.exit(fromPromise(() => serviceClose()));
          if (Exit.isFailure(exit)) failures.push(originalError(exit.cause));
        }
        const agentExit = yield* Effect.exit(fromPromise(() => agent.close()));
        if (Exit.isFailure(agentExit)) failures.push(originalError(agentExit.cause));
        const finalExit =
          failures.length === 0
            ? Exit.void
            : Exit.fail(
                new PromiseFailure(
                  failures.length === 1 ? failures[0] : new AggregateError(failures, "the agent did not close cleanly"),
                ),
              );
        yield* Deferred.done(decision.done, finalExit);
      }),
    );
    return yield* Deferred.await(decision.done);
  });

  let localClose: Promise<void> | undefined;
  return {
    info: agent.info,
    usage: agent.usage,
    sessions: agent.sessions,
    messages: agent.messages,
    invoke: invoker.invoke,
    invokeStream: invoker.invokeStream,
    ...(agent.closed === undefined ? {} : { closed: agent.closed }),
    ready: () => Ref.getUnsafe(state)._tag !== "closed" && (agent.ready?.() ?? true),
    busy: () => opened.busy(),
    serve: (serveOptions = {}) => runServingPromise(serveEffect(serveOptions)),
    close: () => {
      if (localClose === undefined) {
        localClose = runServingPromise(closeEffect());
        trackInFlightClose(opened.storageKey, localClose);
      }
      return localClose;
    },
  };
}
