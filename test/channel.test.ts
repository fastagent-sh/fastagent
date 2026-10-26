/** A definition's channels, mounted: their routes merged, their connections bound, a bad shape refused by name. */
import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agent-api.ts";
import type { ChannelModule } from "../src/channel.ts";
import {
  type AnyChannelModule,
  channelIngress,
  channelModuleProblem,
  mountChannels,
} from "../src/channels/discover.ts";

const ctx = { agent: {} as Agent, stateRoot: "/unused-in-tests" };
const accepted = () => new Response(null, { status: 202 });
const mount = (modules: Record<string, unknown>) =>
  mountChannels(new Map(Object.entries(modules) as [string, AnyChannelModule][]), ctx);

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

  it("refuses a relative stateRoot (the contract says absolute)", () => {
    expect(() => mountChannels(new Map(), { agent: {} as Agent, stateRoot: "rel/state" })).toThrow(
      /stateRoot must be absolute/,
    );
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
