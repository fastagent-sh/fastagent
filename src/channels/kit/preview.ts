/**
 * Channel live-preview state/formatting (`createTurnView`, `applyTurnEvent`) and scoped outbound delivery (`renderReply`,
 * `previewPump`, `serialWriter`).
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Json, SessionEvent } from "../../agent-api.ts";
import { answerText } from "../../answer-text.ts";
import { PortFailure, portError, portJoin } from "../../effect-port.ts";
import { log } from "../../log.ts";
import type { TurnEvent } from "./invoke.ts";
import { truncateCodePointPrefix, truncateCodePointSuffix } from "./text.ts";

export interface ChannelFailure {
  details: string;
  retryable: boolean;
  code?: string;
}

export function defaultErrorMessage(failed: ChannelFailure): string {
  return failed.retryable
    ? "⚠️ Temporary problem — please try again in a moment."
    : "⚠️ Sorry, something went wrong. Try rephrasing, or check I have access to what you need.";
}

export const RETRY_NOTICE = "⏳ Temporary problem — retrying…";
export const THINKING_PLACEHOLDER = "💭 Thinking…";

interface ToolLine {
  label: string;
  status: "running" | "ok" | "error";
  progress?: string;
}

export interface TurnView {
  thinking: string;
  tools: ToolLine[];
  toolById: Map<string, ToolLine>;
  answer: string;
  textOf: (event: SessionEvent) => string;
  answerSince?: number;
  retrying: boolean;
}

export function createTurnView(): TurnView {
  return {
    thinking: "",
    tools: [],
    toolById: new Map(),
    answer: "",
    textOf: answerText(),
    retrying: false,
  };
}

export function applyTurnEvent(view: TurnView, e: TurnEvent, now = Date.now()): boolean {
  const closedRetry = view.retrying && e.type !== "retrying";
  if (closedRetry) view.retrying = false;
  const appended = (text: string): boolean => {
    if (text === "") return closedRetry;
    view.answer += text;
    if (view.answerSince === undefined && view.answer.trim() !== "") view.answerSince = now;
    return true;
  };
  switch (e.type) {
    case "delta":
      if (e.channel === "text") return appended(view.textOf(e));
      view.thinking += e.text;
      return true;
    case "tool_started": {
      const arg = summarizeToolArgs(e.args);
      const name = humanizeToolName(e.name);
      const line: ToolLine = { label: arg ? `${name} ${arg}` : name, status: "running" };
      view.tools.push(line);
      view.toolById.set(e.toolCallId, line);
      return true;
    }
    case "tool_progress": {
      const line = view.toolById.get(e.toolCallId);
      if (line?.status !== "running") return closedRetry;
      line.progress = e.text;
      return true;
    }
    case "entry": {
      if (e.entry.kind === "assistant") return appended(view.textOf(e));
      if (e.entry.kind !== "tool_result") return closedRetry;
      const data = e.entry.data as { toolCallId?: string; isError?: boolean };
      const line = data.toolCallId === undefined ? undefined : view.toolById.get(data.toolCallId);
      if (!line) return closedRetry;
      line.status = data.isError === true ? "error" : "ok";
      return true;
    }
    case "retrying":
      view.retrying = true;
      return true;
    default:
      return closedRetry;
  }
}

const TOOL_MARK = { running: "…", ok: "✓", error: "✗" } as const;

export function toolLines(view: TurnView): string {
  return view.tools
    .map((t) => {
      const progress = t.status === "running" && t.progress ? ` › ${clip(t.progress, TOOL_PROGRESS_MAX)}` : "";
      return `🔧 ${t.label} ${TOOL_MARK[t.status]}${progress}`;
    })
    .join("\n");
}

export function thinkingLine(view: TurnView, maxTail: number): string {
  const t = view.thinking.replace(/\s+/g, " ").trim();
  return t === "" ? "" : `💭 ${truncateCodePointSuffix(t, maxTail)}`;
}

export function revealedAnswer(view: TurnView, ageMs: number, now = Date.now()): string {
  if (view.answer.trim() === "" || view.answerSince === undefined) return "";
  return now - view.answerSince >= ageMs ? view.answer : "";
}

export function composeTurnBody(parts: readonly string[]): string {
  return parts
    .filter((s) => s.trim() !== "")
    .join("\n\n")
    .trim();
}

const TOOL_ARG_MAX = 48;
const TOOL_PROGRESS_MAX = 64;
const TOOL_NAME_MAX = 80;

function clip(s: string, max = TOOL_ARG_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  return truncateCodePointPrefix(one, max);
}

export function summarizeToolArgs(args: Json): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return clip(String(args));
  const values = Object.values(args);
  const primary = values.find((v) => typeof v === "string" || typeof v === "number");
  if (primary !== undefined) return clip(String(primary));
  return values.length > 0 ? clip(JSON.stringify(args)) : "";
}

export function humanizeToolName(name: string): string {
  const normalize = (s: string): string =>
    s
      .replace(/[_\-.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const base = mcp ? `${normalize(mcp[1] ?? "")}: ${normalize(mcp[2] ?? "")}` : normalize(name);
  const label = base.trim() || name.trim() || "Tool";
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  return truncateCodePointPrefix(capitalized, TOOL_NAME_MAX);
}

export type TurnEnd = { answered: true } | { failure: ChannelFailure };

export function turnEnd(event: TurnEvent, messageId: string | undefined): TurnEnd | undefined {
  if (event.type === "rejected") {
    const { code, message, retryable } = event.error;
    return { failure: { details: message, retryable, code } };
  }
  if (event.type !== "done" || event.message.id !== messageId) return undefined;
  const { status, error } = event.message;
  switch (status) {
    case "completed":
    case "incomplete":
      return { answered: true };
    case "failed":
      return {
        failure: {
          details: error?.message ?? "the message failed",
          retryable: error?.retryable ?? false,
          code: error?.code ?? "failed",
        },
      };
    case "canceled":
      return { failure: { details: "the message was canceled", retryable: false, code: "canceled" } };
    default:
      return undefined;
  }
}

export function unfinishedTurn(streamError: string | undefined): ChannelFailure | undefined {
  return streamError === undefined ? undefined : { details: streamError, retryable: true, code: "stream_error" };
}

export function renderReply(
  events: Stream.Stream<TurnEvent, PortFailure>,
  opts: {
    label: string;
    onEvent: (event: TurnEvent) => void;
    finish: Effect.Effect<void>;
    answer: () => string;
    settle: (text: string) => Effect.Effect<void, PortFailure>;
    formatError: (failure: ChannelFailure) => string | undefined;
    onAnswered?: (answer: string) => void;
  },
): Effect.Effect<void, PortFailure, Scope.Scope> {
  return Effect.gen(function* () {
    let finalized = false;
    const notify = (failure: ChannelFailure, phase: string) =>
      Effect.try({ try: () => opts.formatError(failure) ?? "", catch: (cause) => new PortFailure(cause) }).pipe(
        Effect.flatMap(opts.settle),
        Effect.catchTag("PortFailure", (error) =>
          Effect.sync(() => log.error(`${opts.label} failed to deliver the ${phase} notice: ${String(error.cause)}`)),
        ),
      );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* opts.finish;
        if (!finalized)
          yield* notify({ details: "the turn ended without completing", retryable: false }, "abnormal-turn");
      }),
    );
    let messageId: string | undefined;
    let streamError: string | undefined;
    const failWith = (failure: ChannelFailure) =>
      Effect.gen(function* () {
        yield* notify(failure, "agent-failure");
        return yield* Effect.fail(
          new PortFailure(new Error(`agent failed: ${failure.details} (retryable=${failure.retryable})`)),
        );
      });
    yield* Stream.runForEachWhile(events, (event) => {
      if (event.type === "message") messageId = event.message.id;
      if (event.type === "stream_error") streamError = event.error.message;
      const end = turnEnd(event, messageId);
      if (end === undefined) {
        return Effect.try({
          try: () => {
            opts.onEvent(event);
            return true;
          },
          catch: (cause) => new PortFailure(cause),
        });
      }
      return Effect.gen(function* () {
        yield* opts.finish;
        finalized = true;
        if ("answered" in end) {
          const answer = opts.answer();
          yield* Effect.try({
            try: () => opts.onAnswered?.(answer),
            catch: (cause) => new PortFailure(cause),
          });
          yield* opts.settle(answer);
        } else {
          return yield* failWith(end.failure);
        }
        return false;
      }).pipe(Effect.uninterruptible);
    });
    if (finalized) return;
    const unfinished = unfinishedTurn(streamError);
    if (unfinished === undefined) {
      return yield* Effect.fail(new PortFailure(new Error("stream ended without a terminal event")));
    }
    yield* opts.finish;
    finalized = true;
    yield* failWith(unfinished).pipe(Effect.uninterruptible);
  });
}

export interface PreviewPump {
  touch(): void;
  finish: Effect.Effect<void>;
}

export function previewPump(opts: {
  flush: () => Promise<void>;
  throttleMs: number;
  beforeFlush?: Effect.Effect<void>;
  onError: (error: unknown) => void;
}): Effect.Effect<PreviewPump, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const run = Effect.runSyncWith(yield* Effect.context<never>());
    let fiber: Fiber.Fiber<void> | undefined;
    let stopped = false;
    let dirty = false;
    let reported = false;
    const work = Effect.gen(function* () {
      while (dirty && !stopped) {
        dirty = false;
        if (opts.beforeFlush) yield* opts.beforeFlush;
        yield* portJoin(opts.flush).pipe(
          Effect.catchTag("PortFailure", (error) =>
            Effect.sync(() => {
              if (!reported) {
                reported = true;
                opts.onError(error.cause);
              }
            }),
          ),
          Effect.uninterruptible,
        );
        if (dirty && !stopped) yield* Effect.sleep(opts.throttleMs);
      }
    });
    const finish = Effect.gen(function* () {
      stopped = true;
      if (!fiber) return;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) yield* Effect.failCause(exit.cause);
    });
    yield* Effect.addFinalizer(() => finish);
    return {
      touch: () => {
        if (stopped) return;
        dirty = true;
        const exit = fiber?.pollUnsafe();
        if (fiber && (!exit || Exit.isFailure(exit))) return;
        fiber = run(Effect.forkIn(work, scope, { startImmediately: true }));
      },
      finish,
    };
  });
}

export interface SerialWriter {
  enqueue(work: () => Promise<void>): void;
  finish: Effect.Effect<void, PortFailure>;
}

export function serialWriter(): Effect.Effect<SerialWriter, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<() => Promise<void>, Cause.Done>();
    const work = Effect.gen(function* () {
      for (;;) {
        const next = yield* Queue.take(queue);
        yield* portJoin(next).pipe(Effect.uninterruptible);
      }
    }).pipe(Effect.catchTag("Done", () => Effect.void));
    const fiber = yield* Effect.forkScoped(work);
    const end = Effect.sync(() => {
      Queue.endUnsafe(queue);
    });
    let reported = false;
    const finish = end.pipe(
      Effect.andThen(Fiber.join(fiber)),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (!Exit.hasInterrupts(exit)) reported = true;
        }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      end.pipe(
        Effect.andThen(Fiber.await(fiber)),
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) && !reported && !Cause.hasInterruptsOnly(exit.cause)
            ? Effect.sync(() =>
                log.error(`[delivery] a write failed after its turn stopped: ${String(portError(exit.cause))}`),
              )
            : Effect.void,
        ),
      ),
    );
    return {
      enqueue: (next) => {
        if (!Queue.offerUnsafe(queue, next)) throw new Error("delivery writer is closed");
      },
      finish,
    };
  });
}
