/**
 * Shared pieces of channel turn invocation: stream ownership (`eventStream`), turn lifecycle (`turnStream`),
 * background attachment loading, and prompt manifests.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type Agent,
  AgentError,
  type AgentErrorData,
  type Message,
  type MessageStreamEvent,
  type SendRequest,
} from "../../agent-api.ts";
import { PromiseFailure, originalError, joinPromise } from "../../promise-bridge.ts";
import { log } from "../../log.ts";

/** Acquire lazily; interruption closes the source, while natural exhaustion needs no extra return. */
function eventStream<A>(open: () => AsyncIterable<A>, label: string): Stream.Stream<A, PromiseFailure, Scope.Scope> {
  return Stream.fromPull(
    Effect.gen(function* () {
      let exhausted = false;
      const iterator = yield* Effect.acquireRelease(
        Effect.try({ try: () => open()[Symbol.asyncIterator](), catch: (cause) => new PromiseFailure(cause) }),
        (iterator) => {
          const close = iterator.return?.bind(iterator);
          if (!close || exhausted) return Effect.void;
          return Effect.promise(close).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.warn(`${label} source cleanup failed: ${String(Cause.squash(cause))}`)),
            ),
          );
        },
      );
      return Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) => new PromiseFailure(cause),
        });
        if (result.done) {
          exhausted = true;
          return yield* Cause.done();
        }
        return [result.value] as const;
      });
    }),
  );
}

export type TurnEvent = { type: "rejected"; error: AgentErrorData } | MessageStreamEvent;

export interface SteeredTurn {
  admitted(): void;
  observe(message: Message): void;
}

export interface ImageAttachment {
  mimeType: string;
  data: string;
}

type MessageContent = Exclude<SendRequest["content"], string>;

export function promptContent(text: string, images: readonly ImageAttachment[] | undefined): MessageContent {
  return [{ type: "text", text }, ...(images ?? []).map((image) => ({ type: "image" as const, ...image }))];
}

export function turnStream<R>(opts: {
  agent: Agent;
  label: string;
  session: () => Promise<string>;
  enter?: (sessionId: string) => () => void;
  resolve: () => Promise<R>;
  turn: (resolved: R) => { content: MessageContent; idempotencyKey: string };
  retryableLoadFailure: (cause: unknown) => boolean;
  steer: SteeredTurn;
}): Stream.Stream<TurnEvent, PromiseFailure> {
  const rejected = (error: AgentErrorData) => Stream.succeed<TurnEvent>({ type: "rejected", error });
  return Stream.unwrap(
    Effect.gen(function* () {
      const prepared = yield* Effect.result(joinPromise(opts.resolve));
      if (Result.isFailure(prepared)) {
        const { cause } = prepared.failure;
        return rejected({
          code: "unavailable",
          message: `could not prepare the turn: ${String(cause)}`,
          retryable: opts.retryableLoadFailure(cause),
        });
      }
      const resolved = prepared.success;
      const session = yield* Effect.result(joinPromise(() => opts.session()));
      if (Result.isFailure(session)) return rejected(agentFailure("its session", session.failure.cause));
      const sessionId = session.success;
      const enter = opts.enter;
      if (enter !== undefined)
        yield* Effect.acquireRelease(
          Effect.sync(() => enter(sessionId)),
          (leave) => Effect.sync(leave),
        );
      const { content, idempotencyKey } = opts.turn(resolved);
      const request = { sessionId, content, idempotencyKey, whenBusy: "steer" } as const;
      let messageId: string | undefined;
      const watched = (event: TurnEvent): void => {
        if (event.type === "message") {
          messageId = event.message.id;
          opts.steer.admitted();
        } else if (event.type === "done" && event.message.id === messageId) opts.steer.observe(event.message);
      };
      return eventStream(() => opts.agent.messages.stream(request), `${opts.label} (session=${sessionId})`).pipe(
        Stream.tap((event) => Effect.sync(() => watched(event))),
        Stream.scoped,
        Stream.catchCause((cause) => {
          const error = originalError(cause);
          return error instanceof AgentError ? rejected(agentFailure("its message", error)) : Stream.failCause(cause);
        }),
      );
    }),
  );
}

function agentFailure(what: string, cause: unknown): AgentErrorData {
  if (cause instanceof AgentError) {
    const { code, message, retryable, details } = cause;
    return {
      code,
      message: `could not start ${what}: ${message}`,
      retryable: retryable || code === "unconfirmed",
      ...(details === undefined ? {} : { details }),
    };
  }
  return { code: "unavailable", message: `could not start ${what}: ${String(cause)}`, retryable: true };
}

export async function loadBackground<R, T>(
  refs: readonly R[],
  load: (ref: R) => Promise<T>,
  opts: { label: string; what: string },
): Promise<{ loaded: { ref: R; value: T }[]; lost: number }> {
  const loaded: { ref: R; value: T }[] = [];
  let lost = 0;
  const results = await Promise.allSettled(refs.map(load));
  for (const [index, result] of results.entries()) {
    const ref = refs[index] as R;
    if (result.status === "fulfilled") loaded.push({ ref, value: result.value });
    else {
      lost++;
      log.warn(`${opts.label} could not load an earlier (buffered) ${opts.what}: ${String(result.reason)}`);
    }
  }
  return { loaded, lost };
}

export interface ManifestFile {
  name: string;
  size: number;
  path: string;
}

export function attachedFilesManifest(files: readonly ManifestFile[]): string {
  return files.length
    ? `\n\n[attached files:\n${files.map((f) => `- ${f.name} (${f.size} bytes) → ${f.path}`).join("\n")}\n]`
    : "";
}

export function attributedFileName(name: string, from: string, msg?: string | number): string {
  return `${name} (from ${from}${msg !== undefined ? `, msg ${msg}` : ""}, earlier discussion)`;
}

export function backgroundImagesManifest(
  primaryCount: number,
  refs: readonly { from: string; messageId: string }[],
): string {
  return refs.length
    ? `\n\n[background vision images from earlier discussion — appended after ${primaryCount} primary image(s):\n${refs
        .map((ref, index) => `- vision image ${primaryCount + index + 1}: from ${ref.from}, msg ${ref.messageId}`)
        .join("\n")}\n]`
    : "";
}

export function missingAttachmentsNote(missing: number): string {
  return missing > 0
    ? `\n[note: ${missing} attachment(s) from the earlier discussion are not loaded (no longer available, or older than the most recent few)]`
    : "";
}
