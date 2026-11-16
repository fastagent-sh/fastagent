/** A definition's channels, mounted: each with its context, their routes merged, a bad shape refused by name. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../../src/agent-api.ts";
import type { Channel } from "../../../src/channel.ts";
import { channelContext } from "../../../src/channels/context.ts";
import { channelIngress, channelProblem, mountChannels } from "../../../src/channels/discover.ts";
import { scriptedAgent } from "../../doubles/scripted-agent.ts";

afterEach(() => vi.restoreAllMocks());

const freshRoot = () => mkdtempSync(join(tmpdir(), "fa-channel-"));
const accepted = () => new Response(null, { status: 202 });
const mount = (channels: Record<string, Channel>) =>
  mountChannels(new Map(Object.entries(channels)), {} as Agent, freshRoot());
const routes = (keyed: Record<string, () => Response>): Channel => ({ routes: () => keyed });

describe("mountChannels", () => {
  it("merges every route channel's routes and binds each long connection; none mounts nothing", () => {
    expect(mount({})).toEqual({ routes: {}, longConnections: [], routeChannels: [] });
    const socket: Channel = {
      connect: () => ({ ready: Promise.resolve(), closed: new Promise<void>(() => {}) }),
    };
    const mounted = mount({
      github: routes({ "POST /webhook": accepted }),
      stripe: routes({ "POST /stripe": accepted }),
      socket,
    });
    expect(Object.keys(mounted.routes).sort()).toEqual(["POST /stripe", "POST /webhook"]);
    expect(mounted.routeChannels).toEqual(["github", "stripe"]);
    expect(mounted.longConnections.map((connection) => connection.name)).toEqual(["socket"]);
  });

  it("refuses a route another channel already serves, naming both", () => {
    expect(() => mount({ a: routes({ "POST /hook": accepted }), b: routes({ "/hook": accepted }) })).toThrow(
      'channel "b" serves "/hook", which channel "a" already serves as "POST /hook"',
    );
  });
});

describe("channelProblem: what fastagent.config.ts may declare as a channel", () => {
  const tool = { name: "send", description: "send it", parameters: { type: "object" }, execute: async () => "" };

  it("accepts a route channel and a connection channel, with tools", () => {
    expect(channelProblem({ routes: () => ({}) })).toBeUndefined();
    expect(channelProblem({ connect: () => ({}), tools: [tool] })).toBeUndefined();
    expect(channelIngress({ routes: () => ({}) })).toBe("webhook");
    expect(channelIngress({ connect: () => ({}) as never })).toBe("long-connection");
  });

  it("refuses anything else, saying what it must be", () => {
    for (const value of [undefined, 1, () => ({}), { routes() {}, connect() {} }]) {
      expect(channelProblem(value)).toMatch(/must be a channel \(defineChannel\), receiving by routes\(ctx\) or/);
    }
    expect(channelProblem({ connect() {}, tools: [{ ...tool, name: "Send-it" }] })).toBe(
      "tools[0].name must be lowercase letters, digits and _, starting with a letter",
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
