/**
 * The SPEC conformance suite (spec-conformance.ts) against the `AgentSession` L0 — the proof that
 * pi's own session class satisfies the four Agent-side MUSTs in the `per-invoke` posture, MUST 6
 * (portability) included: every turn builds a fresh `AgentSession` over the same jsonl on disk, with
 * nothing shared in-process but the directory.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  ModelRuntime,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { createPiAgentFromSession, type PiAgentSessionFactory } from "../src/engines/pi/invoke-session.ts";
import { piInMemorySessionRecordStore, piSessionRecordStore } from "../src/engines/pi/session-store.ts";
import { collect, AgentFailure } from "../src/collect.ts";
import { busyRetryStream } from "../src/channels/kit/invoke-turn-kit.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { runQueuedTurn } from "../src/channels/kit/turn-runner.ts";
import type { TurnRecordBase } from "../src/channels/kit/turn-store.ts";
import { telegramTurnStream } from "../src/channels/telegram/invoke-turn.ts";
import { telegramReply } from "../src/channels/telegram/preview.ts";
import { createScheduler } from "../src/schedule/scheduler.ts";
import { saveFires, scheduleFile, writeScheduleFile } from "../src/schedule/state.ts";
import { listWakeups } from "../src/schedule/wakeups.ts";
import { readRuns } from "../src/schedule/audit.ts";

afterEach(() => vi.restoreAllMocks());
import { makeFaux } from "./faux.ts";
import { describeSpecConformance } from "./spec-conformance.ts";
import { inProcessLease } from "../src/engines/pi/turn-kit.ts";

/**
 * A per-invoke `AgentSession` factory over one faux model. `dir` makes the record durable (the
 * portability subject); without it each turn gets a fresh in-memory session.
 *
 * `services` is built ONCE and shared across turns — the per-turn cost is the session binding only,
 * which is what makes this posture affordable.
 */
interface SubjectOptions {
  /** Where the record lives. Omitted — a fresh in-memory session per turn (no continuity needed). */
  dir?: string;
  /** Mounted on the session, for the paths where a turn has to do something before it answers. */
  customTools?: ToolDefinition[];
}

async function sessionFactory(
  responses: FauxResponseStep[],
  { dir, customTools }: SubjectOptions = {},
): Promise<PiAgentSessionFactory> {
  const { faux } = makeFaux();
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const cwd = process.cwd();
  const services = await createAgentSessionServices({
    cwd,
    modelRuntime,
    resourceLoaderOptions: {
      // The agent is the definition, not the authoring machine's pi setup (same posture as serving).
      noExtensions: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPromptOverride: () => "test",
      appendSystemPromptOverride: () => [],
      skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
    },
  });
  const store = dir === undefined ? piInMemorySessionRecordStore({ cwd }) : piSessionRecordStore({ dir, cwd });
  return async (sessionId) => {
    const sessionManager = await store.openOrCreate(sessionId);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: faux.getModel(),
      // "builtin" not "all": the coding tools stay off (this is a protocol subject, not an agent),
      // while a subject that mounts its own tool keeps it.
      noTools: "builtin",
      customTools,
    });
    return session;
  };
}

async function piSessionAgent(responses: FauxResponseStep[], options?: SubjectOptions) {
  return createPiAgentFromSession({ sessionFactory: await sessionFactory(responses, options) });
}

describeSpecConformance("pi AgentSession (faux model, per-invoke L0)", {
  completing: () => piSessionAgent([fauxAssistantMessage("hello world")]),

  // The answer streams a token before it fails, so the L0 refuses pi's retry and the subject stays
  // failed - no backoff, and the refusal itself is exercised by every conformance run.
  failing: () => piSessionAgent([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom 500" })]),

  hanging: async (onCleanup) => {
    const factory = await sessionFactory([fauxAssistantMessage("a long answer that streams out slowly")]);
    // The engine's cancel cleanup is session.abort() — intercept it as the probe.
    return createPiAgentFromSession({
      sessionFactory: async (sessionId) => {
        const session = await factory(sessionId);
        const abort = session.abort.bind(session);
        (session as { abort: AgentSession["abort"] }).abort = async () => {
          onCleanup();
          return abort();
        };
        return session;
      },
    });
  },

  // Portable conformance: two agent instances, each building its own SessionManager over the same
  // directory — nothing shared in-process, the disk is the only common state.
  pair: async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-session-conformance-"));
    let saw = false;
    const a = await piSessionAgent([fauxAssistantMessage("the code is 47")], { dir });
    const b = await piSessionAgent(
      [
        (context) => {
          saw = JSON.stringify(context.messages).includes("the code is 47");
          return fauxAssistantMessage("ok");
        },
      ],
      { dir },
    );
    return { a, b, sawHistory: () => saw };
  },
});

describe("AgentSession L0: pi's auto-retry vs. append-only deltas", () => {
  it("a failure AFTER output was streamed is final — a retry would concatenate two answers", async () => {
    const agent = await piSessionAgent([
      fauxAssistantMessage("the first half of a wrong", { stopReason: "error", errorMessage: "boom 500" }),
      fauxAssistantMessage("a complete replacement answer"),
    ]);
    const started = Date.now();
    await expect(collect(agent.invoke({ session: "streamed-then-failed" }, { text: "go" }))).rejects.toBeInstanceOf(
      AgentFailure,
    );
    // Refusing the retry must also CANCEL it: pi's first backoff is 2s, and letting it run would
    // both delay the failure and spend a provider call on an answer this turn can never use.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a failure BEFORE any output still retries — that window is free resilience", async () => {
    const agent = await piSessionAgent([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom 500" }),
      fauxAssistantMessage("the answer, second attempt"),
    ]);
    const { text } = await collect(agent.invoke({ session: "silent-then-retried" }, { text: "go" }));
    expect(text).toBe("the answer, second attempt");
  });

  it("an executed tool does not close the window — the retry resumes from it instead of re-running it", async () => {
    let toolRuns = 0;
    const agent = await piSessionAgent(
      [
        fauxAssistantMessage(fauxToolCall("ping", {}, { id: "call-1" })),
        // The request that follows the tool fails before saying anything. pi retries it against the
        // PERSISTED tool result; refusing here would hand the retry to the caller, who has no way to
        // re-ask without running the tool again.
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom 500" }),
        fauxAssistantMessage("pong, once"),
      ],
      {
        // The cast is the same one session-builder.ts makes: pi types `parameters` per-tool, so a
        // literal only satisfies ToolDefinition after erasure.
        customTools: [
          {
            name: "ping",
            label: "ping",
            description: "A tool with a side effect worth not repeating.",
            parameters: Type.Object({}),
            execute: async () => {
              toolRuns++;
              return { content: [{ type: "text", text: "pong" }] };
            },
          } as unknown as ToolDefinition,
        ],
      },
    );

    const { text } = await collect(agent.invoke({ session: "tool-then-retried" }, { text: "go" }));

    expect(text).toBe("pong, once");
    expect(toolRuns).toBe(1);
  });
});

it.each([
  ["return", "direct"],
  ["throw", "direct"],
  ["abort", "channel"],
  ["interrupt", "channel"],
  ["abort", "delivery"],
  ["interrupt", "delivery"],
] as const)(
  "quiet consumer %s through %s aborts the actual tool and joins cleanup before releasing",
  async (method, entry) => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    const lease = inProcessLease();
    const factory = await sessionFactory([fauxAssistantMessage(fauxToolCall("wait", {}, { id: "blocked" }))], {
      customTools: [
        {
          name: "wait",
          label: "wait",
          description: "Wait for cancellation",
          parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
            entered.resolve();
            await finishCleanup.promise;
            return { content: [{ type: "text", text: "cleaned" }], details: {} };
          },
        } as ToolDefinition,
      ],
    });
    let disposed = false;
    const agent = createPiAgentFromSession({
      lease,
      sessionFactory: async (id) => {
        const session = await factory(id);
        const dispose = session.dispose.bind(session);
        session.dispose = () => {
          disposed = true;
          dispose();
        };
        return session;
      },
    });
    if (entry === "delivery") {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json({ ok: true, result: { message_id: 1 } }),
      );
    }
    const removed = vi.fn();
    const stop = (() => {
      if (entry === "direct") {
        const iterator = agent.invoke({ session: "quiet" }, { text: "go" })[Symbol.asyncIterator]();
        const first = iterator.next();
        return async () => {
          expect((await first).value).toMatchObject({ type: "tool_started" });
          const pending = iterator.next();
          const error = new Error("consumer stopped");
          if (method === "return") await iterator.return?.();
          else await expect(iterator.throw?.(error)).rejects.toBe(error);
          expect(await pending).toEqual({ done: true, value: undefined });
        };
      }
      const work =
        entry === "delivery"
          ? runQueuedTurn<TurnRecordBase, TurnRecordBase, never>(
              {
                label: "[test]",
                store: { add: () => {}, remove: removed, recover: () => [], startAttempt: () => "run" },
                buffer: { push: () => {}, peek: () => ({ text: "", consumed: [] }), commit: () => {} },
                toStored: (rec) => ({ ...rec, attempts: 0 }),
                fromStored: (rec) => rec,
                bufferKey: () => "quiet",
                where: () => "test",
                onDeferred: () => {},
                notifyDropped: () => {},
                execute: () =>
                  telegramReply(
                    telegramTurnStream(
                      agent,
                      "quiet",
                      "go",
                      { api: "https://api.telegram.org", botToken: "token", chatId: 1, filesDir: "/tmp" },
                      { primary: { imageFileIds: [], fileIds: [] }, buffered: { images: [], files: [], skipped: 0 } },
                    ),
                    "https://api.telegram.org",
                    "token",
                    { chatId: 1 },
                    () => "neutral notice",
                  ),
              },
              { id: "turn", session: "quiet", attempts: 0 },
            )
          : Stream.runDrain(busyRetryStream(agent, { session: "quiet" }, { text: "go" }, { label: "[test]" }));
      if (method === "abort") {
        const abort = new AbortController();
        const done = Effect.runPromiseExit(work, { signal: abort.signal });
        return async () => {
          abort.abort();
          const exit = await done;
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        };
      }
      const fiber = Effect.runFork(work);
      return async () => {
        await Effect.runPromise(Fiber.interrupt(fiber));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      };
    })();
    await entered.promise;
    const closing = stop();
    try {
      await aborted.promise;
      expect(disposed).toBe(false);
      expect(lease.tryAcquire("quiet")).toBeNull();
    } finally {
      finishCleanup.resolve();
      await closing;
    }
    expect(disposed).toBe(true);
    expect(removed).not.toHaveBeenCalled();
    const release = lease.tryAcquire("quiet");
    expect(release).toBeTypeOf("function");
    release?.();
  },
);

it("scheduler stop lets a claimed cron OR wake finish its actual SDK tool and audit", async () => {
  for (const kind of ["cron", "wake"] as const) {
    const stateRoot = await mkdtemp(join(tmpdir(), "fa-scheduled-sdk-"));
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const abort = vi.fn();
    const lease = inProcessLease();
    const sessionId = kind === "cron" ? "schedule:job" : "conversation";
    const factory = await sessionFactory(
      [fauxAssistantMessage(fauxToolCall("wait", {}, { id: "scheduled-tool" })), fauxAssistantMessage("done")],
      {
        customTools: [
          {
            name: "wait",
            label: "wait",
            description: "Wait for completion",
            parameters: Type.Object({}),
            execute: async (_id, _args, signal) => {
              signal!.addEventListener("abort", abort, { once: true });
              entered.resolve();
              await finish.promise;
              return { content: [{ type: "text", text: "finished" }], details: {} };
            },
          } as ToolDefinition,
        ],
      },
    );
    const bound = vi.fn(factory);
    const agent = createPiAgentFromSession({ lease, sessionFactory: bound });
    if (kind === "cron") saveFires(stateRoot, { job: "2026-07-07T08:00:00Z" });
    else
      writeScheduleFile(scheduleFile(stateRoot, "wakeups"), [
        { id: "first", session: sessionId, prompt: "go", fireAt: "2026-07-07T09:00:00Z" },
        { id: "next", session: "other", prompt: "later", fireAt: "2026-07-07T09:00:00Z" },
      ]);
    const s = Effect.runSync(
      createScheduler({
        agent,
        stateRoot,
        schedules: kind === "cron" ? [{ name: "job", cron: "0 * * * *", prompt: "go" }] : [],
        now: () => new Date("2026-07-07T10:30:00Z"),
      }),
    );
    try {
      s.start();
      await entered.promise;
      expect(s.stop()).toBeUndefined();
      expect(abort).not.toHaveBeenCalled();
      expect(lease.tryAcquire(sessionId)).toBeNull();
      expect(readRuns(stateRoot)).toEqual([]);
      finish.resolve();
      await vi.waitFor(() => expect(readRuns(stateRoot)).toHaveLength(1));
      expect(readRuns(stateRoot)[0]).toMatchObject({ outcome: "completed", reply: "done" });
      expect(abort).not.toHaveBeenCalled();
      expect(bound).toHaveBeenCalledOnce();
      if (kind === "wake") expect(listWakeups(stateRoot).map((w) => w.id)).toEqual(["next"]);
      const release = lease.tryAcquire(sessionId);
      expect(release).toBeTypeOf("function");
      release?.();
    } finally {
      s.stop();
      finish.resolve();
    }
  }
});
