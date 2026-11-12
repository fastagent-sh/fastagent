/** A definition's channels, mounted: each with its context, their routes merged, a bad shape refused by name. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent-api.ts";
import type { ChannelModule } from "../src/channel.ts";
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

  it("keeps one session per conversation, recorded before it is returned, two first calls included", async () => {
    const { agent, ctx } = contextOf();
    const [first, second] = await Promise.all([ctx.sessionFor("chat-1"), ctx.sessionFor("chat-1")]);
    expect(first).toBe(second);
    expect(agent.forks).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(ctx.stateDir, "sessions.json"), "utf8"))).toEqual({ "chat-1": first });
    expect(await ctx.sessionFor("chat-2")).not.toBe(first);
  });
});
