/** A definition's channels, mounted: each with its context, their routes merged, a bad shape refused by name. */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent-api.ts";
import type { ChannelContext, ChannelModule } from "../src/channel.ts";
import { activeWork } from "../src/channels/busy.ts";
import { channelContext } from "../src/channels/context.ts";
import {
  type AnyChannelModule,
  channelIngress,
  channelModuleProblem,
  mountChannels,
} from "../src/channels/discover.ts";
import { scriptedAgent } from "./scripted-agent.ts";

afterEach(() => vi.restoreAllMocks());

const freshRoot = () => mkdtempSync(join(tmpdir(), "fa-channel-"));
const accepted = () => new Response(null, { status: 202 });
const mount = (modules: Record<string, unknown>) =>
  mountChannels(new Map(Object.entries(modules) as [string, AnyChannelModule][]), {} as Agent, freshRoot());

describe("mountChannels", () => {
  it("merges every route channel's routes and binds each long connection; none mounts nothing", () => {
    expect(mount({})).toEqual({ routes: {}, longConnections: [], routeChannels: [] });
    const socket = { name: "socket", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) };
    const mounted = mount({
      github: (() => ({ "POST /webhook": accepted })) satisfies ChannelModule,
      stripe: (() => ({ "POST /stripe": accepted })) satisfies ChannelModule,
      socket,
    });
    expect(Object.keys(mounted.routes).sort()).toEqual(["POST /stripe", "POST /webhook"]);
    expect(mounted.routeChannels).toEqual(["github", "stripe"]);
    expect(mounted.longConnections.map((connection) => connection.name)).toEqual(["socket"]);
  });

  it("refuses a route another channel already serves, naming both", () => {
    expect(() => mount({ a: () => ({ "POST /hook": accepted }), b: () => ({ "/hook": accepted }) })).toThrow(
      'src/channels/b serves "/hook", which src/channels/a already serves as "POST /hook"',
    );
  });

  it("hands each channel the context of its own name, a long connection's included", () => {
    const root = freshRoot();
    const seen: string[] = [];
    const { longConnections } = mountChannels(
      new Map<string, AnyChannelModule>([
        [
          "acme",
          (ctx) => {
            seen.push(ctx.stateDir);
            return { "POST /acme": accepted };
          },
        ],
        [
          "socket",
          {
            name: "socket-mode",
            connect: (ctx) => {
              seen.push(ctx.stateDir);
              return { ready: Promise.resolve(), closed: new Promise<void>(() => {}) };
            },
          },
        ],
      ]),
      {} as Agent,
      root,
    );
    for (const connection of longConnections) connection.connect(new AbortController().signal);
    expect(seen).toEqual([join(root, "channels", "acme"), join(root, "channels", "socket")]);
  });

  it("a factory's own failure is the mount's", () => {
    expect(() =>
      mount({
        boom: () => {
          throw new Error("TELEGRAM_BOT_TOKEN is not set");
        },
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is not set");
  });

  it("refuses an async factory with a Promise-specific message, and leaves no unhandled rejection", () => {
    expect(() =>
      mount({
        async: async () => {
          throw new Error("setup boom");
        },
      }),
    ).toThrow(/must return Routes synchronously/);
  });

  it("refuses a factory that yields no routes (null, a number, an array, a Map, {})", () => {
    for (const routes of [null, 42, [], new Map([["POST /webhook", accepted]]), {}]) {
      expect(() => mount({ bad: () => routes })).toThrow(/must return a Routes object|declared no routes/);
    }
  });

  it("refuses a malformed route table: a bad key, or a value that is not a handler", () => {
    for (const [routes, message] of [
      [[accepted], /is not a valid route key/], // an array's key is "0"
      [{ webhook: accepted }, /is not a valid route key/], // no leading /
      [{ "POST /webhook": 42 }, /must map to a handler function/],
    ] as const) {
      expect(() => mount({ bad: () => routes })).toThrow(message);
    }
  });
});

describe("channelModuleProblem: what a channel file default-exports", () => {
  it("accepts a route factory and a named long connection, by shape", () => {
    expect(channelModuleProblem(() => ({}))).toBeUndefined();
    const socket = { name: "socket", connect: () => ({}) };
    expect(channelModuleProblem(socket)).toBeUndefined();
    expect(channelIngress(() => ({}))).toBe("webhook");
    expect(channelIngress(socket as never)).toBe("long-connection");
  });

  it("refuses anything else, saying what it must be", () => {
    for (const value of [undefined, 1, { name: "socket", start() {} }]) {
      expect(channelModuleProblem(value)).toMatch(/must default-export \(ctx\) => Routes or \{ name, connect/);
    }
    expect(channelModuleProblem({ name: " ", connect: () => ({}) })).toBe(
      "long-connection channel name must be a non-empty string",
    );
  });
});

describe("channelContext: what a channel is handed", () => {
  const contextOf = (agent = scriptedAgent(() => [])) => {
    const root = freshRoot();
    return { root, agent, ctx: channelContext(agent, root, "acme") };
  };

  it("gives the channel a directory of its own, made at the mount, and refuses a relative state root", () => {
    const { root, ctx } = contextOf();
    expect(ctx.stateDir).toBe(join(root, "channels", "acme"));
    expect(existsSync(ctx.stateDir)).toBe(true);
    expect(() =>
      channelContext(
        scriptedAgent(() => []),
        "rel/state",
        "acme",
      ),
    ).toThrow(/must be absolute/);
  });

  it("keeps one session per conversation, recorded before it is returned, two first calls included", async () => {
    const { agent, ctx } = contextOf();
    const [first, second] = await Promise.all([ctx.sessionFor("chat-1"), ctx.sessionFor("chat-1")]);
    expect(first).toBe(second);
    expect(agent.forks).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(ctx.stateDir, "sessions.json"), "utf8"))).toEqual({ "chat-1": first });
    expect(await ctx.sessionFor("chat-2")).not.toBe(first);
  });

  it("forks a new conversation from what forkFrom answers, asked only while it has no session", async () => {
    const { agent, ctx } = contextOf();
    const room = await ctx.sessionFor("room");
    const forkFrom = vi.fn(async () => ({ sessionId: room }));
    const thread = await ctx.sessionFor("room/thread", { forkFrom });
    expect(agent.forks.at(-1)).toEqual({ forkFrom: { sessionId: room } });
    expect(await ctx.sessionFor("room/thread", { forkFrom })).toBe(thread);
    expect(forkFrom).toHaveBeenCalledOnce();
  });

  it("reads a recorded session without making one", async () => {
    const { agent, ctx } = contextOf();
    expect(ctx.recordedSession("chat-1")).toBeUndefined();
    expect(agent.forks).toHaveLength(0);
    const session = await ctx.sessionFor("chat-1");
    expect(ctx.recordedSession("chat-1")).toBe(session);
  });

  it("runs a place's turns one at a time in order, counted as work, and says a failed one in the log", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    const { ctx } = contextOf();
    const base = activeWork();
    const order: string[] = [];
    let release = () => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = Promise.withResolvers<void>();
    (ctx as ChannelContext).turn("chat-1", async () => {
      await first;
      order.push("first");
    });
    ctx.turn("chat-1", async () => {
      order.push("second");
      throw new Error("the reply could not be posted");
    });
    ctx.turn("chat-2", async () => {
      order.push("other place");
      done.resolve();
    });
    expect(activeWork()).toBe(base + 3);
    await done.promise;
    expect(order).toEqual(["other place"]);
    release();
    await vi.waitFor(() => expect(activeWork()).toBe(base));
    expect(order).toEqual(["other place", "first", "second"]);
    expect(errors.join("\n")).toContain("[acme] turn failed (place=chat-1): Error: the reply could not be posted");
    expect(errors.join("\n")).not.toContain("run()");
  });
});
