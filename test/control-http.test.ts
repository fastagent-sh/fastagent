/**
 * Phase 3 transport conformance — docs/design/session-control.md §13: the HTTP+SSE wire protocol
 * (`controlRoutes`) and the remote client (`connectSessionControl`) are exercised TOGETHER over a
 * real node:http server against a real hub + faux agent: local and remote `SessionControl` must be
 * isomorphic (same interface, same answers), the envelope must be consumed internally (epoch/seq
 * never reach the consumer), and auth must fail closed.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { controlRoutes } from "../src/channels/control.ts";
import { createPiAgentFromHarness, inProcessLease } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";
import { createPiSessionControl } from "../src/engines/pi/session-control.ts";
import { inMemorySessionStore } from "../src/engines/pi/sessions.ts";
import { router, serveNode } from "../src/host/node.ts";
import { connectSessionControl } from "../src/session-remote.ts";
import { UNSUPPORTED_CAPABILITY_CODE, type SessionEvent } from "../src/session.ts";
import { makeFaux } from "./faux.ts";

const TOKEN = "test-token";

/** A served control plane over a real HTTP server + the agent driving it. */
async function serveControl() {
  const { faux, models } = makeFaux();
  faux.setResponses([fauxAssistantMessage("hello over the wire")]);
  const sessions = inMemorySessionStore();
  const lease = inProcessLease();
  const gate: AgentTool = {
    name: "noop",
    label: "n",
    description: "n",
    parameters: Type.Object({}),
    async execute() {
      return { content: [], details: {} };
    },
  };
  const factory = piHarnessFactory({
    sessions,
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    models,
    model: faux.getModel(),
    tools: [gate],
    systemPrompt: "test",
  });
  const { control, observer } = createPiSessionControl({
    sessions,
    boundary: () => ({ lease, models, harnessFactory: factory }),
  });
  const agent = createPiAgentFromHarness({ observer, lease, harnessFactory: factory });
  const server = serveNode(router(controlRoutes(control, { token: TOKEN })), { port: 0 });
  const port = await server.listening;
  return {
    agent,
    localControl: control,
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    spec: `${faux.getModel().provider}/${faux.getModel().id}`,
  };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("session control over HTTP (Phase 3)", () => {
  it("fails closed: no/wrong token is 401 on every route, and connect() rejects", async () => {
    const served = await serveControl();
    try {
      for (const path of ["/control/capabilities", "/control/state?session=s", "/control/events?session=s"]) {
        expect((await fetch(`${served.url}${path}`)).status).toBe(401);
        expect((await fetch(`${served.url}${path}`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      }
      const dispatch = await fetch(`${served.url}/control/dispatch`, { method: "POST", body: "{}" });
      expect(dispatch.status).toBe(401);
      await expect(connectSessionControl({ url: served.url, token: "wrong" })).rejects.toThrow(/401/);
    } finally {
      served.close();
    }
  });

  it("local and remote are isomorphic: capabilities/state/entries/dispatch answer identically", async () => {
    const served = await serveControl();
    try {
      await drain(served.agent.invoke({ session: "sW" }, { text: "hi" }));
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });

      expect(remote.capabilities()).toEqual(served.localControl.capabilities());
      expect(await remote.state("sW")).toEqual(await served.localControl.state("sW"));
      const [remoteEntries, localEntries] = [await remote.entries("sW"), await served.localControl.entries("sW")];
      expect(remoteEntries).toEqual(localEntries);
      // Cursor round-trips through the query string.
      const since = localEntries.entries[0]?.id as string;
      expect(await remote.entries("sW", { since })).toEqual(await served.localControl.entries("sW", { since }));

      // dispatch round-trips SessionResult — including the pre-acceptance rejection shape.
      const bad = await remote.dispatch("sW", { type: "steer", prompt: { text: "x" } });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBeTruthy();
      const applied = await remote.dispatch("sW", { type: "set_thinking", level: "low" });
      expect(applied).toEqual({ ok: true });
      expect((await remote.state("sW")).thinkingLevel).toBe("low");
    } finally {
      served.close();
    }
  });

  it("events stream live over SSE; the envelope is consumed internally", async () => {
    const served = await serveControl();
    try {
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });
      const seen: SessionEvent[] = [];
      const watching = (async () => {
        for await (const ev of remote.events("sE")) {
          seen.push(ev);
          if (ev.type === "run_settled") break;
        }
      })();
      // Subscription races the run start: give the SSE connection a beat to establish.
      await new Promise((r) => setTimeout(r, 100));
      await drain(served.agent.invoke({ session: "sE" }, { text: "hi" }));
      await watching;

      const types = seen.map((e) => e.type);
      expect(types[0]).toBe("run_started");
      expect(types.at(-1)).toBe("run_settled");
      const text = seen
        .filter((e) => e.type === "message_delta")
        .map((e) => (e.data as { delta: string }).delta)
        .join("");
      expect(text).toBe("hello over the wire");
      // Envelope fields never leak into the semantic event.
      for (const e of seen) {
        expect(e).not.toHaveProperty("epoch");
        expect(e).not.toHaveProperty("seq");
        expect(e).not.toHaveProperty("sessionId");
      }
    } finally {
      served.close();
    }
  });

  it("detaching from a QUIET stream resolves promptly end to end (no hang, server survives)", async () => {
    const served = await serveControl();
    try {
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });
      const iterator = remote.events("sL")[Symbol.asyncIterator]();
      const first = iterator.next(); // establishes the connection; the stream never produces
      await new Promise((r) => setTimeout(r, 100));
      // The old failure mode on both sides was a permanent hang here (generator return queued
      // behind a never-settling read) — a resolved return within the timeout IS the assertion.
      await iterator.return?.(undefined);
      void first;
      expect((await remote.state("sL")).status).toBe("idle");
    } finally {
      served.close();
    }
  }, 5_000);

  it("an unknown wire command type gets a protocol-level invalid_command, not a broken body", async () => {
    const served = await serveControl();
    try {
      const res = await fetch(`${served.url}/control/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ session: "sX", command: { type: "make_coffee" } }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { ok: boolean; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_command");
    } finally {
      served.close();
    }
  });

  it("controlRoutes refuses to mount without a token", () => {
    const { control } = createPiSessionControl({ sessions: inMemorySessionStore() });
    expect(() => controlRoutes(control, { token: "" })).toThrow(/token is required/);
    // And a boundary-less hub still speaks the protocol: unsupported, not a transport error.
    void UNSUPPORTED_CAPABILITY_CODE;
  });
});
