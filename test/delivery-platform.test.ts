import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentEvent } from "../src/agent.ts";
import type { FeishuApi } from "../src/channels/feishu/feishu-api.ts";
import { feishuReply } from "../src/channels/feishu/preview.ts";
import { busyRetryStream } from "../src/channels/kit/invoke-turn-kit.ts";
import type { PortFailure } from "../src/effect-port.ts";
import { slackReply } from "../src/channels/slack/preview.ts";
import type { SlackApi } from "../src/channels/slack/slack-api.ts";
import { telegramReply } from "../src/channels/telegram/preview.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const platforms = ["telegram", "feishu", "slack-classic", "slack-native"] as const;
type Platform = (typeof platforms)[number];

afterEach(() => vi.restoreAllMocks());

function renderer(platform: Platform, open: () => Promise<void>, settle: () => Promise<void>) {
  const neutral = () => "neutral notice";
  if (platform === "telegram") {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/sendMessage")) await open();
      else if (String(input).endsWith("/editMessageText")) await settle();
      else throw new Error(`unexpected Telegram call: ${String(input)}`);
      return Response.json({ ok: true, result: { message_id: 17 } });
    });
    return (events: Stream.Stream<AgentEvent, PortFailure>) =>
      telegramReply(events, "https://api.telegram.org", "token", { chatId: 1 }, neutral);
  }
  if (platform === "feishu") {
    const api = {
      createCard: async () => "card-1",
      sendMessage: async () => {
        await open();
        return "message-1";
      },
      updateCard: async () => {
        await settle();
      },
      updateCardElement: async () => {},
    } as unknown as FeishuApi;
    return (events: Stream.Stream<AgentEvent, PortFailure>) => feishuReply(events, api, { chatId: "chat-1" }, neutral);
  }
  const api = {
    postMarkdown: async () => {
      await open();
      return "1.0";
    },
    updateMarkdown: async () => {
      await settle();
    },
    startStream: async () => {
      await open();
      return "1.0";
    },
    appendStream: async () => {},
    sendMarkdown: async () => {
      await settle();
      return { ts: "1.0", channelId: "C1" };
    },
    stopStream: async () => {
      await settle();
    },
  } as unknown as SlackApi;
  return (events: Stream.Stream<AgentEvent, PortFailure>) =>
    slackReply(events, api, { channelId: "C1", threadTs: "1.0" }, neutral, {
      rendering: platform === "slack-classic" ? "classic" : "native",
      disclaimer: false,
    });
}

it.each(platforms)(
  "%s joins a late preview acquisition and terminal delivery before releasing ownership",
  async (platform) => {
    const opened = Promise.withResolvers<void>();
    const releaseOpen = Promise.withResolvers<void>();
    const settling = Promise.withResolvers<void>();
    const releaseFinal = Promise.withResolvers<void>();
    const open = vi.fn(async () => {
      opened.resolve();
      await releaseOpen.promise;
    });
    const settle = vi.fn(async () => {
      settling.resolve();
      await releaseFinal.promise;
    });
    const render = renderer(platform, open, settle);
    let released = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = Stream.fromIterable<AgentEvent>([
          { type: "thinking", delta: "working" },
          { type: "tool_started", id: "t1", name: "read", args: {} },
        ]).pipe(Stream.concat(Stream.never));
        const turn = yield* Effect.forkChild(
          Effect.scoped(render(events)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released = true;
              }),
            ),
          ),
        );
        yield* Effect.promise(() => opened.promise);
        const closing = yield* Effect.forkChild(Fiber.interrupt(turn));
        yield* Effect.promise(tick);
        expect(released).toBe(false);
        expect(settle).not.toHaveBeenCalled();
        releaseOpen.resolve();
        yield* TestClock.adjust(3_000);
        yield* Effect.promise(() => settling.promise);
        expect(released).toBe(false);
        releaseFinal.resolve();
        yield* Fiber.join(closing);
        const exit = yield* Fiber.await(turn);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(released).toBe(true);
        yield* TestClock.adjust(60_000);
        expect(open).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);

it.each(platforms)(
  "%s commits completion before delivery and keeps source cleanup behind the final write",
  async (platform) => {
    const settling = Promise.withResolvers<void>();
    const releaseFinal = Promise.withResolvers<void>();
    const committed = vi.fn();
    let sourceClosed = false;
    const agent: Agent = {
      async *invoke() {
        try {
          yield { type: "text", delta: "answer" };
          yield { type: "completed" };
        } finally {
          sourceClosed = true;
        }
      },
    };
    const render = renderer(
      platform,
      async () => {},
      async () => {
        settling.resolve();
        expect(committed).toHaveBeenCalledOnce();
        expect(sourceClosed).toBe(false);
        await releaseFinal.promise;
      },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const turn = yield* Effect.forkChild(
          Effect.scoped(
            render(
              busyRetryStream(agent, { session: "s" }, { text: "go" }, { label: "[test]", onCompleted: committed }),
            ),
          ),
        );
        yield* Effect.promise(() => settling.promise);
        releaseFinal.resolve();
        yield* Fiber.join(turn);
        expect(sourceClosed).toBe(true);
        expect(committed).toHaveBeenCalledOnce();
      }),
    );
  },
);
