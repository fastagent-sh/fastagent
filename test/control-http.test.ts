/**
 * Phase 3 transport conformance — docs/design/session-control.md §13: the HTTP+SSE wire protocol
 * (`createControlPlane`) and the remote client (`connectSessionControl`) are exercised TOGETHER over a
 * real node:http server against a real hub + faux agent: local and remote `SessionControl` must be
 * isomorphic (same interface, same answers), the envelope must be consumed internally (epoch/seq
 * never reach the consumer), and auth must fail closed.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { controlPlaneRoutes, createControlPlane, mountControlPlane } from "../src/channels/control.ts";
import { log } from "../src/log.ts";
import { inProcessLease } from "../src/engines/pi/turn-kit.ts";
import { fauxAgent, fauxControlledAgent } from "./agent.ts";
import { createPiSessionControl } from "../src/engines/pi/session-control.ts";
import { createPiAgentFromSession, type PiAgentSessionFactory } from "../src/engines/pi/invoke-session.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import { router, serveNode } from "../src/channels/serve.ts";
import { connectAgent, connectSessionControl } from "../src/session-remote.ts";
import { SESSIONS_UNAVAILABLE_CODE, UNSUPPORTED_CAPABILITY_CODE, type SessionEvent } from "../src/session.ts";
import { describeSpecConformance } from "./spec-conformance.ts";

const TOKEN = "test-token";

/** A served control plane over a real HTTP server + the agent driving it. Reasoning-capable model:
 *  thinking levels are per model, and the default faux supports only "off". */
async function serveControl() {
  /** What the served control answers `commands()` with — mutable, so a test can change it while a
   *  client is connected (the definition behind it is live). */
  const commandList: Array<{ name: string; description?: string; source: string }> = [
    { name: "triage", description: "Sort an inbox", source: "skill" },
  ];
  const gate: AgentTool = {
    name: "noop",
    label: "n",
    description: "n",
    parameters: Type.Object({}),
    async execute() {
      return { content: [], details: {} };
    },
  };
  const { agent, control, faux } = await fauxControlledAgent([fauxAssistantMessage("hello over the wire")], {
    faux: { models: [{ id: "faux-thinker", reasoning: true }] },
    tools: [gate],
    // A non-empty, MUTABLE list: non-empty so the isomorphism check compares a real payload rather
    // than [] === [], mutable so the wire is pinned as per-call rather than prefetched-and-cached
    // like capabilities (the definition it answers for is live).
    commands: async () => [...commandList],
  });
  const plane = createControlPlane(control, { token: TOKEN, agent });
  const server = serveNode(router({}, [plane]), { port: 0 });
  const port = await server.listening;
  return {
    agent,
    commandList,
    // The plane's OWN routes: the mount point is one wildcard key, so sweeps derive from here.
    routeKeys: Object.keys(controlPlaneRoutes(control, { token: TOKEN, agent })),
    localControl: control,
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    spec: `${faux.getModel().provider}/${faux.getModel().id}`,
  };
}

/** A control whose per-session calls are the ones given — the handle shape, faked. `attachRound`
 *  takes a SessionControl and reaches a session through it, so a fake has to have that shape too. */
function handleControl(session: Record<string, unknown>): never {
  return {
    capabilities: () => ({}) as never,
    commands: async () => [],
    sessions: { list: async () => [], fork: async () => ({ ok: true }), get: () => session },
  } as never;
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
      // DERIVED from the routes this server actually MOUNTS — not a hand-kept list, and not a second
      // createControlPlane() call that could drift from it: "every control route requires the token" has
      // to fail when a NEW route forgets `guard`, which a literal array cannot do.
      expect(served.routeKeys).toContain("GET /control/commands"); // the route this PR adds is in the sweep
      for (const key of served.routeKeys) {
        const [method, path] = key.split(" ") as [string, string];
        // OPTIONS is the ONE unauthenticated method here, and deliberately so: a preflight cannot
        // carry a token. Asserted below rather than skipped silently.
        if (method === "OPTIONS") continue;
        const url = `${served.url}${path.replace("{session}", "s")}?session=s`;
        expect((await fetch(url, { method, body: method === "POST" ? "{}" : undefined })).status).toBe(401);
        expect(
          (
            await fetch(url, {
              method,
              body: method === "POST" ? "{}" : undefined,
              headers: { authorization: "Bearer wrong" },
            })
          ).status,
        ).toBe(401);
      }
      await expect(connectSessionControl({ url: served.url, token: "wrong" })).rejects.toThrow(/401/);
    } finally {
      served.close();
    }
  });

  it("a browser can reach the plane: preflight without a token, CORS headers on every answer", async () => {
    const served = await serveControl();
    const origin = (res: Response) => res.headers.get("access-control-allow-origin");
    /** The check a BROWSER performs, not a string compare: everything the preflight named must be
     *  covered. Pinning the exact header value instead is what let `content-type` go missing while
     *  the assertion passed — and with it the plane's two write routes. */
    const permits = (res: Response, method: string, headers: string[]) => {
      const listed = (name: string) =>
        (res.headers.get(name) ?? "").split(",").map((part) => part.trim().toLowerCase());
      return {
        method: listed("access-control-allow-methods").includes(method.toLowerCase()),
        headers: headers.every((h) => listed("access-control-allow-headers").includes(h.toLowerCase())),
      };
    };
    try {
      // DERIVED from what the server MOUNTS, like the 401 sweep: a route added later cannot ship
      // browser-unreachable, and a POST route is checked as a POST route.
      expect(served.routeKeys).toContain("POST /control/sessions/{session}/actions");
      for (const key of served.routeKeys) {
        const [method, path] = key.split(" ") as [string, string];
        if (method === "OPTIONS") continue;
        // What the browser would actually name: a JSON body is NOT a safelisted content-type, so
        // every POST preflight carries it alongside the token header.
        const requested = method === "POST" ? ["authorization", "content-type"] : ["authorization"];
        // The methods advertised must be the ones this PATH serves. Advertising a method the path
        // does not serve sends the browser into a host-generated 405 that carries no CORS headers.
        const servedHere = served.routeKeys
          .filter((k) => k.endsWith(` ${path}`))
          .map((k) => k.split(" ")[0] as string)
          .filter((m) => m !== "OPTIONS"); // OPTIONS is derived, and compared out of `advertised` too
        // No token — a preflight cannot carry credentials, which is its entire purpose.
        const res = await fetch(`${served.url}${path.replace("{session}", "s")}`, {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:5173",
            "access-control-request-method": method,
            "access-control-request-headers": requested.join(", "),
          },
        });
        expect({ path: key, status: res.status, origin: origin(res) }).toEqual({
          path: key,
          status: 204,
          origin: "*",
        });
        expect({ path: key, ...permits(res, method, requested) }).toEqual({
          path: key,
          method: true,
          headers: true,
        });
        const advertised = (res.headers.get("access-control-allow-methods") ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter((m) => m !== "OPTIONS")
          .sort();
        // What the path serves — including the HEAD the router answers from every GET route, which
        // the browser would otherwise refuse to send.
        const expectedMethods = [...new Set(servedHere.flatMap((m) => (m === "GET" ? ["GET", "HEAD"] : [m])))].sort();
        expect({ path, advertised }).toEqual({ path, advertised: expectedMethods });
      }

      // A rejected call must stay READABLE: without the headers the browser hands the client an
      // opaque network error instead of the 401 that says "your token is wrong".
      expect(origin(await fetch(`${served.url}/control/capabilities`))).toBe("*");
      // 400 (authenticated, missing param) and 200 alike.
      const auth = { authorization: `Bearer ${TOKEN}` };
      expect(origin(await fetch(`${served.url}/control/sessions/s`, { headers: auth }))).toBe("*");
      expect(origin(await fetch(`${served.url}/control/capabilities`, { headers: auth }))).toBe("*");
      // SSE too — the long-lived route a GUI actually renders from. Asserted at the handler, not
      // over the wire: a quiet session sends no chunk, and Node withholds response headers until
      // one, so a fetch here would block for the full heartbeat interval.
      const { control } = await fauxControlledAgent([]);
      // Through the PLANE, not the bare handler: CORS is a property of the plane's exit now, so
      // reaching past it would assert nothing about what a browser receives.
      const plane = mountControlPlane(controlPlaneRoutes(control, { token: TOKEN })).handler;
      const sse = await plane(new Request("http://x/control/sessions/s/events", { headers: auth }));
      expect(sse.headers.get("content-type")).toBe("text/event-stream");
      expect(origin(sse)).toBe("*");
      await sse.body?.cancel();
    } finally {
      served.close();
    }
  });

  it("a browser can actually GET to the 404/405 — preflight does not veto them first", async () => {
    // The failure this closes: CORS headers on a 404 are useless if the browser never sends the
    // request. Preflight runs BEFORE it, and a preflight that answers 404 (unknown path) or omits
    // the requested method (unsupported method) stops the real request — leaving the client with the
    // opaque network error this plane exists to remove. Node's fetch does not enforce that gate, so
    // asserting through it proves nothing; this models the gate explicitly.
    const served = await serveControl();
    const browserWouldSend = async (method: string, path: string) => {
      const pre = await fetch(`${served.url}${path}`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": method },
      });
      const allowed = (pre.headers.get("access-control-allow-methods") ?? "")
        .split(",")
        .map((m) => m.trim().toUpperCase());
      return pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*" && allowed.includes(method);
    };
    try {
      // An unknown path under the prefix, and a known path under a method it does not serve.
      expect(await browserWouldSend("GET", "/control/nonexistent")).toBe(true);
      expect(await browserWouldSend("GET", "/control/sessions/s/actions")).toBe(true);
      // ...and only because the gate opens do the plane's own answers become readable.
      const auth = { authorization: `Bearer ${TOKEN}` };
      expect((await fetch(`${served.url}/control/nonexistent`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${served.url}/control/sessions/sW/actions`, { headers: auth })).status).toBe(405);
    } finally {
      served.close();
    }
  });

  it("the replies no route produces are the plane's own, and a browser can read all of them", async () => {
    // THE reason the plane owns its prefix. Each of these is generated where no route runs, so
    // while the plane was a flat route dictionary they came from the HOST — bare, unreadable to a
    // browser, and each discovered separately. Owning the prefix makes them the plane's answers.
    const served = await serveControl();
    const cors = (res: Response) => res.headers.get("access-control-allow-origin");
    try {
      const auth = { authorization: `Bearer ${TOKEN}` };
      // 1. A path under the prefix that no route serves. 404 (not 405) is load-bearing: a remote
      //    client reads it as "this serve predates the route", i.e. version skew, not a fault.
      const unknown = await fetch(`${served.url}/control/nonexistent`, { headers: auth });
      expect({ status: unknown.status, cors: cors(unknown) }).toEqual({ status: 404, cors: "*" });
      // 2. A known path under a method it does not serve.
      const wrongMethod = await fetch(`${served.url}/control/sessions/sW/actions`, { headers: auth });
      expect({ status: wrongMethod.status, cors: cors(wrongMethod) }).toEqual({ status: 405, cors: "*" });
      // 3. Outside the prefix stays the HOST's business — the plane must not answer for the whole
      //    server, only for what it owns.
      expect((await fetch(`${served.url}/not-control`)).status).toBe(404);
      // 3b. The plane's own 404 carries no content for HEAD. Asserted at the handler: over a socket
      //     Node suppresses a HEAD body itself, so going through fetch would prove nothing.
      const { control: quiet } = await fauxControlledAgent([]);
      const plane = mountControlPlane(controlPlaneRoutes(quiet, { token: TOKEN })).handler;
      const headMissing = await plane(new Request("http://x/control/nope", { headers: auth, method: "HEAD" }));
      expect(headMissing.status).toBe(404);
      expect(await headMissing.text()).toBe("");
      // 4. A percent-encoded spelling is a DIFFERENT path, answered like any other unknown one —
      //    and still readably. Paths are matched as they arrive: decoding them first would undo the
      //    normalisation `URL` already performed, turning `%2F..%2F` back into `/../`. No client
      //    sends these (the remote client percent-encodes session ids into a path segment).
      const encoded = await fetch(`${served.url}/control/%63apabilities`, { headers: auth });
      expect({ status: encoded.status, cors: cors(encoded) }).toEqual({ status: 404, cors: "*" });
      // 5. A HEAD the plane will actually serve must not be refused by its own advertisement.
      const headable = await fetch(`${served.url}/control/capabilities`, { method: "HEAD", headers: auth });
      const getable = await fetch(`${served.url}/control/capabilities`, { headers: auth });
      expect(headable.status).toBe(getable.status);
      expect(await headable.text()).toBe(""); // HEAD carries no content (RFC 9110)...
      expect(headable.headers.get("content-type")).toBe(getable.headers.get("content-type")); // ...but keeps headers
      await getable.text();
    } finally {
      served.close();
    }
  });

  it("a handler that REJECTS still answers a browser: CORS-bearing 500, not an opaque network error", async () => {
    // The host has its own totality boundary, but its synthesized 500 carries no CORS headers — so
    // without the plane's own catch, the one failure `commands()` admits is invisible to a GUI.
    const { control } = await fauxControlledAgent([], {
      commands: async () => {
        throw new Error("skills/ unreadable: permission denied");
      },
    });
    const server = serveNode(router({}, [createControlPlane(control, { token: TOKEN })]), { port: 0 });
    const port = await server.listening;
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/commands`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      // Failing visibly is not optional just because the client now gets a readable status.
      expect(errors.mock.calls.map(String).join("\n")).toMatch(/permission denied/);
      // ...and the internal message stays internal.
      expect(await res.text()).not.toMatch(/permission denied/);
    } finally {
      errors.mockRestore();
      server.close();
    }
  });

  it("local and remote are isomorphic: capabilities/state/entries/dispatch answer identically", async () => {
    const served = await serveControl();
    try {
      await drain(served.agent.invoke({ session: "sW" }, { text: "hi" }));
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });

      expect(remote.capabilities()).toEqual(served.localControl.capabilities());
      expect(await remote.commands()).toEqual(await served.localControl.commands());
      expect(await remote.sessions.get("sW").state()).toEqual(await served.localControl.sessions.get("sW").state());
      const [remoteEntries, localEntries] = [
        await remote.sessions.get("sW").entries(),
        await served.localControl.sessions.get("sW").entries(),
      ];
      expect(remoteEntries).toEqual(localEntries);
      // Cursor round-trips through the query string.
      const since = localEntries.entries[0]?.id as string;
      expect(await remote.sessions.get("sW").entries({ since })).toEqual(
        await served.localControl.sessions.get("sW").entries({ since }),
      );

      // dispatch round-trips SessionResult — including the pre-acceptance rejection shape.
      const bad = await remote.sessions.get("sW").steer({ text: "x" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBeTruthy();
      const applied = await remote.sessions.get("sW").update({ thinkingLevel: "low" });
      expect(applied).toEqual({ ok: true });
      expect((await remote.sessions.get("sW").state()).thinkingLevel).toBe("low");
      // A leaf move carries a field of its own, so its wire shape needs a POSITIVE round trip: a typo
      // in the field name would otherwise ship green behind the malformed-command assertions.
      const target = localEntries.entries.find((e) => e.kind === "user")?.id as string;
      expect(await remote.sessions.get("sW").update({ leafEntryId: target })).toEqual({ ok: true });
      expect((await remote.sessions.get("sW").state()).leafEntryId).toBe(target);
    } finally {
      served.close();
    }
  });

  it("a serve without the route reads as SKEW, not as an unreadable definition", async () => {
    // Both arrive as an uncoded non-2xx; without the distinction a client reports "this agent's
    // skills are unreadable" about a serve that simply predates the route.
    const { control } = await fauxControlledAgent([]);
    // Drop the PATH, not one key: a serve that predates the route has no entry for it under any
    // method, so leaving the derived OPTIONS behind would make the path exist and answer 405 —
    // turning a diagnosable skew back into the uncoded failure this distinction exists to prevent.
    const withoutCommands = Object.fromEntries(
      Object.entries(controlPlaneRoutes(control, { token: TOKEN })).filter(
        ([key]) => !key.endsWith(" /control/commands"),
      ),
    );
    const server = serveNode(router({}, [mountControlPlane(withoutCommands)]), { port: 0 });
    const port = await server.listening;
    try {
      const remote = await connectSessionControl({ url: `http://127.0.0.1:${port}`, token: TOKEN });
      await expect(remote.commands()).rejects.toThrow(/predates the route/);
    } finally {
      server.close();
    }
  });

  it("commands() is read per call, not cached at connect like capabilities", async () => {
    // Why the method is async at all: the definition behind it is live, so a list fetched once at
    // connect would advertise names the running agent has already left behind.
    const served = await serveControl();
    try {
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });
      expect((await remote.commands()).map((c) => c.name)).toEqual(["triage"]);
      served.commandList.push({ name: "digest", source: "skill" });
      expect((await remote.commands()).map((c) => c.name)).toEqual(["triage", "digest"]);
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
        for await (const ev of remote.sessions.get("sE").events()) {
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
      const iterator = remote.sessions.get("sL").events()[Symbol.asyncIterator]();
      const first = iterator.next(); // establishes the connection; the stream never produces
      await new Promise((r) => setTimeout(r, 100));
      // The old failure mode on both sides was a permanent hang here (generator return queued
      // behind a never-settling read) — a resolved return within the timeout IS the assertion.
      await iterator.return?.(undefined);
      // The full promise of the name: the PENDING next() settles too (done), never hangs.
      await expect(first).resolves.toMatchObject({ done: true });
      expect((await remote.sessions.get("sL").state()).status).toBe("idle");
    } finally {
      served.close();
    }
  }, 5_000);

  it("steer CARRIES a full Prompt over the wire: the exact images reach the run's controls, junk stripped", async () => {
    // A hub with a registered fake run whose controls RECORD what arrives — proving delivery
    // through transport → parser → rebuild → controls, not merely parser acceptance.
    const { control, observer } = await fauxControlledAgent([]);
    const received: unknown[] = [];
    observer(
      "sImg",
      { type: "run_started", timestamp: Date.now(), runId: "r1", data: {} },
      {
        steer: async (prompt: { text: string }) => {
          received.push(prompt);
        },
        followUp: async () => {},
        abort: async () => {},
      },
    );
    const server = serveNode(router({}, [createControlPlane(control, { token: TOKEN })]), { port: 0 });
    const port = await server.listening;
    try {
      const post = (command: unknown) =>
        fetch(`http://127.0.0.1:${port}/control/sessions/sImg/actions`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(command),
        }).then((r) => r.json() as Promise<{ ok: boolean; error?: { code: string } }>);
      const result = await post({
        type: "steer",
        prompt: { text: "look", images: [{ data: "aGk=", mimeType: "image/png", junk: "stripped" }], extra: 1 },
      });
      expect(result.ok).toBe(true);
      // Construction, not assertion: exactly the contract fields — image content intact, junk gone.
      expect(received).toEqual([{ text: "look", images: [{ data: "aGk=", mimeType: "image/png" }] }]);
      const badImage = await post({ type: "steer", prompt: { text: "look", images: [42] } });
      expect(badImage.error?.code).toBe("invalid_command"); // element-level parse rejection
      // Every command variant's malformed shape answers protocol-level invalid_command — removing
      // any parseWireCommand check line must turn one of these red.
      const malformed: unknown[] = [
        { type: "steer" }, // prompt missing
        { type: "steer", prompt: { text: 42 } }, // text not a string
        { type: "follow_up", prompt: "hi" }, // prompt not an object
        { type: "compact", instructions: 42 }, // instructions not a string
        { type: "set_model", model: 42 }, // model not a string
        { type: "set_thinking", level: 42 }, // level not a string
        { type: "navigate", targetId: 42 }, // targetId not a string
      ];
      for (const command of malformed) {
        const rejected = await post(command);
        expect(rejected.ok).toBe(false);
        expect(rejected.error?.code).toBe("invalid_command");
      }
    } finally {
      server.close();
    }
  });

  it("a definition it cannot read is a deployment fault: commands() rejects, and the wire has no code for it", async () => {
    // The one failure the contract admits on this read — `[]` would claim the agent has no names.
    // A client author should see what it looks like: an opaque non-2xx, not a coded answer. That is
    // the read-side gap tracked on the session-lifecycle issue, not a special case of this route.
    const { control } = await fauxControlledAgent([], {
      commands: async () => {
        throw new Error("skills/ unreadable: permission denied");
      },
    });
    const server = serveNode(router({}, [createControlPlane(control, { token: TOKEN })]), { port: 0 });
    const port = await server.listening;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/commands`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBeGreaterThanOrEqual(500);
      const { ControlRequestError } = await import("../src/session-remote.ts");
      const remote = await connectSessionControl({ url: `http://127.0.0.1:${port}`, token: TOKEN });
      await expect(remote.commands()).rejects.toBeInstanceOf(ControlRequestError);
    } finally {
      server.close();
    }
  });

  it("an unknown wire command type gets a protocol-level invalid_command, not a broken body", async () => {
    const served = await serveControl();
    try {
      const res = await fetch(`${served.url}/control/sessions/sW/actions`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        // An actual unknown TYPE, not a malformed envelope: the body moved to the action itself
        // when the route did, and sending the old wrapper tested the wrong branch — the runtime
        // default arm went uncovered while the name said otherwise.
        body: JSON.stringify({ type: "make_coffee" }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { ok: boolean; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_command");
    } finally {
      served.close();
    }
  });

  it("the remote data plane: connectAgent drives a run through /control/invoke, observed via events", async () => {
    const served = await serveControl();
    try {
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });
      const remoteAgent = connectAgent({ url: served.url, token: TOKEN });
      const seen: SessionEvent[] = [];
      const watching = (async () => {
        for await (const ev of remote.sessions.get("sRD").events()) {
          seen.push(ev);
          if (ev.type === "run_settled") break;
        }
      })();
      await new Promise((r) => setTimeout(r, 100));
      // The full remote instance: the DATA plane starts the run, the control plane watches it.
      const events = await drain(remoteAgent.invoke({ session: "sRD" }, { text: "hi" }));
      expect(events.at(-1)).toEqual({ type: "completed" });
      await watching;
      expect(seen.map((e) => e.type)).toContain("run_started");
      // A REAL Agent: failures are terminal failed EVENTS, never iteration throws (SPEC MUST 2).
      const wrong = connectAgent({ url: served.url, token: "wrong" });
      const unauthorized = await drain(wrong.invoke({ session: "x" }, { text: "hi" }));
      expect(unauthorized).toHaveLength(1);
      expect(unauthorized[0]).toMatchObject({ type: "failed", retryable: false });
      expect((unauthorized[0] as { details: string }).details).toContain("401");
      const withImages = await drain(
        remoteAgent.invoke({ session: "x" }, { text: "hi", images: [{ mimeType: "image/png", data: "x" }] }),
      );
      expect(withImages).toEqual([expect.objectContaining({ type: "failed", retryable: false })]);
      expect((withImages[0] as { details: string }).details).toContain("images");
    } finally {
      served.close();
    }
  });

  it("without an agent, /control/invoke is not mounted", async () => {
    const { control } = await fauxControlledAgent([], { boundary: false });
    const server = serveNode(router({}, [createControlPlane(control, { token: TOKEN })]), { port: 0 });
    const port = await server.listening;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{}",
      });
      expect(res.status).toBe(404);
      // A boundary-less hub still speaks the protocol on the wire: a boundary command answers
      // HTTP 200 + unsupported_capability, never a transport error.
      const dispatch = await fetch(`http://127.0.0.1:${port}/control/sessions/s/actions`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "compact" }),
      });
      expect(dispatch.status).toBe(200);
      const result = (await dispatch.json()) as { ok: boolean; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(UNSUPPORTED_CAPABILITY_CODE);
    } finally {
      server.close();
    }
  });

  it("a black-holed CONNECT is terminated by the watchdog on both streaming planes", async () => {
    // fetch never resolves unless aborted — the connect-phase window no request timeout covers.
    const blackHole = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        if (String(_input).includes("/control/capabilities")) {
          resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      })) as typeof fetch;
    const fakeTimers = await import("vitest").then((m) => m.vi);
    fakeTimers.useFakeTimers();
    try {
      const remote = await connectSessionControl({ url: "http://hole", token: "t", fetchFn: blackHole });
      // The rejection assertion attaches AT CREATION: the promise rejects while timers advance,
      // and a handler attached only afterwards would leave an unhandled-rejection window vitest
      // reports as a run-level error — noise that trains everyone to ignore the real ones.
      const eventsAttempt = expect(
        (async () => {
          for await (const _ of remote.sessions.get("s").events()) void _;
        })(),
      ).rejects.toThrow(/dead connection/);
      const agentAttempt = drain(
        connectAgent({ url: "http://hole", token: "t", fetchFn: blackHole }).invoke({ session: "s" }, { text: "hi" }),
      );
      await fakeTimers.advanceTimersByTimeAsync(4 * 30_000); // past SSE_IDLE_LIMIT_MS
      await eventsAttempt;
      const agentEvents = await agentAttempt;
      expect(agentEvents).toEqual([
        expect.objectContaining({ type: "failed", retryable: true, details: expect.stringContaining("no bytes") }),
      ]);
    } finally {
      fakeTimers.useRealTimers();
    }
  });

  it("a paused consumer never trips the watchdog — it measures pending reads, not pull progress", async () => {
    // A generator parked at yield (rate-limited rendering, a debugger) has NO pending read; the
    // healthy connection must not be misdiagnosed as dead — on the invoke plane that abort would
    // cancel the run the stream drives.
    const fakeTimers = await import("vitest").then((m) => m.vi);
    const enc = new TextEncoder();
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        feed = c;
      },
    });
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).includes("/control/capabilities")) {
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const wire = (seq: number, event: object) =>
      enc.encode(`data: ${JSON.stringify({ sessionId: "s", epoch: "e", seq, event })}\n\n`);
    fakeTimers.useFakeTimers();
    try {
      const remote = await connectSessionControl({ url: "http://x", token: "t", fetchFn });
      const iterator = remote.sessions.get("s").events()[Symbol.asyncIterator]();
      feed.enqueue(wire(0, { type: "run_started", timestamp: 1, data: {} }));
      expect(((await iterator.next()).value as SessionEvent).type).toBe("run_started");
      // The consumer pauses far past the idle limit — no pending read, watchdog disarmed.
      await fakeTimers.advanceTimersByTimeAsync(4 * 30_000);
      // Resume: the connection was never killed; the next event flows.
      const resumed = iterator.next();
      feed.enqueue(wire(1, { type: "run_settled", timestamp: 2, data: { status: "completed" } }));
      expect(((await resumed).value as SessionEvent).type).toBe("run_settled");
      await iterator.return?.(undefined);
    } finally {
      fakeTimers.useRealTimers();
    }
  });

  it("quiet-but-alive streams EMIT heartbeats on both SSE routes — the watchdog's other half", async () => {
    // The client watchdog (90s no bytes → kill) assumes the server pings every 30s; a regression
    // on the emission side would misdiagnose every long tool call as a dead connection. Handlers
    // are called directly (no socket) so fake timers drive the interval.
    const fakeTimers = await import("vitest").then((m) => m.vi);
    const hang = () => new Promise<never>(() => {}); // a stream with no events — quiet, alive
    const quietControl = handleControl({
      events: () => ({ [Symbol.asyncIterator]: () => ({ next: hang, return: async () => ({ done: true }) }) }),
    });
    const quietAgent = {
      invoke: () => ({ [Symbol.asyncIterator]: () => ({ next: hang, return: async () => ({ done: true }) }) }),
    } as never;
    const routes = controlPlaneRoutes(quietControl, { token: TOKEN, agent: quietAgent });
    const auth = { authorization: `Bearer ${TOKEN}` };
    fakeTimers.useFakeTimers();
    try {
      const eventsRoute = routes["GET /control/sessions/{session}/events"];
      const invokeRoute = routes["POST /control/invoke"];
      if (!eventsRoute || !invokeRoute) throw new Error("routes missing");
      for (const [name, res] of [
        ["events", await eventsRoute(new Request("http://x/control/sessions/s/events", { headers: auth }), "s")],
        [
          "invoke",
          await invokeRoute(
            new Request("http://x/control/invoke", {
              method: "POST",
              headers: { ...auth, "content-type": "application/json" },
              body: JSON.stringify({ session: "s", text: "hi" }),
            }),
            "",
          ),
        ],
      ] as const) {
        const reader = (res as Response).body?.getReader();
        if (!reader) throw new Error(`${name}: no body`);
        const read = reader.read();
        await fakeTimers.advanceTimersByTimeAsync(30_000);
        const chunk = await read;
        expect(new TextDecoder().decode(chunk.value)).toBe(": ping\n\n");
        await reader.cancel();
      }
      // cancel() tears the intervals down — no timer may leak past the streams' death.
      expect(fakeTimers.getTimerCount()).toBe(0);
    } finally {
      fakeTimers.useRealTimers();
    }
  });

  it("non-envelope stream data is protocol mismatch — thrown, not misdiagnosed as a gap", async () => {
    const makeFetch = (body: string) =>
      (async (input: string | URL | Request) => {
        if (String(input).includes("/control/capabilities")) {
          return new Response("{}", { headers: { "content-type": "application/json" } });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(body));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch;
    // Valid JSON, wrong shape (a foreign SSE endpoint) — and plain non-JSON: both THROW so a
    // consumer's failure budget applies; reconnecting can never fix a protocol mismatch.
    for (const body of ['data: {"hello":"world"}\n\n', "data: not json at all\n\n"]) {
      const remote = await connectSessionControl({ url: "http://fake", token: "t", fetchFn: makeFetch(body) });
      const iterate = async () => {
        for await (const _ of remote.sessions.get("s").events()) void _;
      };
      await expect(iterate()).rejects.toThrow(/protocol/);
    }
  });

  it("a seq gap throws to the consumer, after yielding everything before it", async () => {
    // Injected fetch: capabilities → JSON; events → an SSE body whose second message skips seq 1.
    const sse = [
      `data: ${JSON.stringify({ sessionId: "s", epoch: "e1", seq: 0, event: { type: "run_started", timestamp: 1, runId: "r", data: {} } })}\n\n`,
      `data: ${JSON.stringify({ sessionId: "s", epoch: "e1", seq: 2, event: { type: "run_settled", timestamp: 2, runId: "r", data: { status: "completed" } } })}\n\n`,
    ];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/control/capabilities")) {
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const block of sse) controller.enqueue(enc.encode(block));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const remote = await connectSessionControl({ url: "http://fake", token: "t", fetchFn });
    const seen: string[] = [];
    // The gap THROWS (same discipline as protocol mismatch) after yielding everything before it:
    // the consumer's failure path owns the diagnostic and its budget ticks.
    const iterate = async () => {
      for await (const ev of remote.sessions.get("s").events()) seen.push(ev.type);
    };
    await expect(iterate()).rejects.toThrow(/sequence gap/);
    expect(seen).toEqual(["run_started"]);
  });

  it("mountSessionControl merges routes and announce writes the 0600 discovery file", async () => {
    const { mkdtemp, rm, readFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { assertNoControlPlaneCollision, mountSessionControl } = await import("../src/service.ts");
    const root = await mkdtemp(join(tmpdir(), "fa-ctl-mount-"));
    const stateRoot = join(root, "nested", ".fastagent"); // deliberately not pre-created
    try {
      const { control } = await fauxControlledAgent([]);
      const base = { "GET /health": () => new Response("ok") };
      const mounted = mountSessionControl(base, control, stateRoot);
      // The plane is a MOUNT, not a route entry: routes stay the channel's literal paths, and the
      // plane arrives beside them owning a prefix. That separation is what keeps every collision
      // check a comparison instead of a prediction about the matcher.
      expect(Object.keys(mounted.routes)).toEqual(["GET /health"]);
      expect(mounted.mounts.map((m) => m.prefix)).toEqual(["/control"]);
      // Collision is PREFIX-level: the plane owns everything under it, so a channel route landing
      // anywhere beneath is shadowed — including a path the plane does not itself serve.
      expect(() => mountSessionControl({ "/control/sessions": () => new Response("x") }, control, stateRoot)).toThrow(
        /collide with the session control plane/,
      );
      // A path the plane does NOT serve is the sharper case: string equality misses it, and the
      // channel then goes dark against the plane's own 404 with nothing reported.
      expect(() => mountSessionControl({ "GET /control/mine": () => new Response("x") }, control, stateRoot)).toThrow(
        /collide with the session control plane/,
      );
      // BOTH mount points enforce it through one function — agentcore's lazy path loads its channels
      // after the boot-time check ran against an empty base, so it must ask again, not re-implement.
      expect(() =>
        assertNoControlPlaneCollision({ "GET /control/mine": () => new Response("x") }, mounted.mounts[0]!),
      ).toThrow(/collide with the session control plane/);
      expect(() =>
        assertNoControlPlaneCollision({ "POST /telegram": () => new Response("x") }, mounted.mounts[0]!),
      ).not.toThrow();
      mounted.announce(12345);
      const file = JSON.parse(await readFile(join(stateRoot, "control.json"), "utf8")) as {
        url: string;
        token: string;
      };
      expect(file.url).toBe("http://127.0.0.1:12345");
      expect(file.token).toBeTruthy();
      expect((await stat(join(stateRoot, "control.json"))).mode & 0o777).toBe(0o600);
      // Without a hub: passthrough, no file side effects.
      const off = mountSessionControl(base, undefined, stateRoot);
      expect(off.routes).toBe(base);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a bind address lands in the discovery url and a loopback bind drops the LAN warning", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mountSessionControl } = await import("../src/service.ts");
    const { log } = await import("../src/log.ts");
    const root = await mkdtemp(join(tmpdir(), "fa-ctl-bind-"));
    try {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const { control } = await fauxControlledAgent([]);
      const url = (host: string | undefined, stateRoot: string) => {
        mountSessionControl({}, control, stateRoot, { host }).announce(9000);
        return readFile(join(stateRoot, "control.json"), "utf8").then((s) => (JSON.parse(s) as { url: string }).url);
      };
      expect(await url("127.0.0.1", join(root, "a"))).toBe("http://127.0.0.1:9000");
      expect(warn).not.toHaveBeenCalled(); // loopback is not LAN-reachable — nothing to warn about
      // A specific non-wildcard bind is only reachable as itself: the client must dial that address.
      expect(await url("192.168.1.5", join(root, "b"))).toBe("http://192.168.1.5:9000");
      // …and the warning NAMES that bind. Counting alone would stay green if the address rendered as
      // `undefined`, which is the whole content of the claim "names the actual bind".
      expect(warn.mock.calls.flat().join(" ")).toContain("192.168.1.5 (off this machine)");
      expect(await url(undefined, join(root, "c"))).toBe("http://127.0.0.1:9000"); // wildcard accepts loopback
      expect(warn.mock.calls.flat().join(" ")).toContain("binds all interfaces");
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("activePathSlice: the replay renders the active branch, not the tree", async () => {
    const { activePathSlice } = await import("../src/cli/commands/attach.ts");
    const entry = (id: string, parentId?: string) => ({ id, parentId, timestamp: 0, kind: "user", data: {} });
    // b is the abandoned branch after a navigate back to a; c hangs off a and holds the leaf.
    const slice = [entry("a"), entry("b", "a"), entry("c", "a")];
    expect(activePathSlice(slice, "c").map((e) => e.id)).toEqual(["a", "c"]);
    // Nothing to reduce against: no leaf reported, or a leaf that predates the slice (its ancestors
    // were rendered in an earlier round) — the slice stands rather than being emptied.
    // An engine that reports no leaf says nothing about branches — "unknown" must not read as
    // "off-path", or such a client would see an empty replay.
    expect(activePathSlice(slice, undefined)).toEqual(slice);
    // A leaf BEHIND the slice (navigate backwards, no turn since): everything here was appended and
    // then abandoned, so there is nothing on the active path to replay.
    expect(activePathSlice(slice, "older")).toEqual([]);
  });

  it("answerSlashInput: every reserved-slash answer, and the order they arrive in", async () => {
    const { answerSlashInput } = await import("../src/cli/commands/attach.ts");
    const commands = [
      { name: "triage", description: "Sort an inbox", source: "skill" },
      { name: "digest", source: "skill" },
    ];
    const say = (list: typeof commands | Error) => {
      const lines: string[] = [];
      const control = {
        commands: async () => {
          if (list instanceof Error) throw list;
          return list;
        },
      };
      return { lines, run: (input: string) => answerSlashInput(input, control as never, (l) => lines.push(l)) };
    };

    // A mistyped control command: the reserved-prefix line is certain and lands FIRST (before the
    // remote read resolves), and the token is reported as naming nothing — not answered with a dump
    // of every skill, which is an intent the typo did not express.
    const typo = say(commands);
    const pending = typo.run("/aboort");
    expect(typo.lines).toEqual([
      "[a leading / is reserved — /abort stops the run, /commands lists what this agent defines]",
    ]);
    await pending;
    expect(typo.lines[1]).toBe("[/aboort names nothing this agent defines]");

    // A real name, WITH arguments: the first word is the token — the whole line would answer "names
    // nothing" for a name the user did give.
    const named = say(commands);
    await named.run("/triage summarize my inbox");
    expect(named.lines[1]).toBe("[triage is a skill — Sort an inbox; name it in a normal message, without the /]");

    // The enumeration: `/commands` alone, with descriptions, and NO reserved-prefix preamble (its
    // whole answer is the read).
    const listed = say(commands);
    await listed.run("/commands");
    expect(listed.lines).toEqual(["[this agent defines: triage — Sort an inbox; digest]"]);

    const none = say([]);
    await none.run("/commands");
    expect(none.lines).toEqual(["[this agent defines no names]"]);

    // The read may reject (an unreadable definition, or a serve predating the route): said, not
    // swallowed — an unhandled rejection here would leave the user with only the preamble.
    const broken = say(new Error("boom"));
    await broken.run("/triage");
    expect(broken.lines[1]).toContain("command list unavailable");
  });

  it("decideRound: every reconnect-loop diagnosis and budget claim, pinned", async () => {
    const { decideRound } = await import("../src/cli/commands/attach.ts");
    const err = (over: Partial<Parameters<typeof decideRound>[0] & { type: "error" }> = {}) =>
      ({ type: "error", error: new Error("boom"), isAuth: false, discovery: "unavailable", ...over }) as never;
    // progress resets the budget.
    expect(decideRound({ type: "progress" }, { discovered: true, downMs: 999_999 })).toEqual({ kind: "reset" });
    // 401 + UNCHANGED control.json (local) → the reachable-and-rejecting diagnosis, not a budget burn.
    expect(decideRound(err({ isAuth: true, discovery: "unchanged" }), { discovered: true, downMs: 0 })).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("control.json is unchanged"),
    });
    // CHANGED credentials → reattach, even when the round's error was a 401 (a fresh boot mints a
    // fresh token, so this round's 401 may already be stale) and even past the budget.
    const fresh = { url: "http://x", token: "t2" };
    expect(
      decideRound(err({ isAuth: true, discovery: "changed", fresh }), { discovered: true, downMs: 999_999 }),
    ).toEqual({ kind: "try-reattach", fresh });
    // Local budget: below 30s → retry with the countdown; at 30s → exit with the crash diagnosis.
    expect(decideRound(err(), { discovered: true, downMs: 29_000 })).toMatchObject({
      kind: "retry",
      warn: expect.stringContaining("limit 30s"),
    });
    expect(decideRound(err(), { discovered: true, downMs: 30_000 })).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("crashed"),
    });
    // Remote: 401 exits immediately with the --token remedy; budget is 120s.
    expect(decideRound(err({ isAuth: true }), { discovered: false, downMs: 0 })).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("--token"),
    });
    expect(decideRound(err(), { discovered: false, downMs: 119_000 })).toMatchObject({ kind: "retry" });
    expect(decideRound(err(), { discovered: false, downMs: 120_000 })).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("unreachable"),
    });
    // Startup phase: the same policy with startup priors — the 401-unchanged diagnosis and
    // reattach-on-changed hold identically; budgets and remedies differ.
    expect(
      decideRound(err({ isAuth: true, discovery: "unchanged" }), { discovered: true, downMs: 0, phase: "startup" }),
    ).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("control.json is unchanged"),
    });
    expect(
      decideRound(err({ discovery: "changed", fresh }), { discovered: true, downMs: 0, phase: "startup" }),
    ).toEqual({ kind: "try-reattach", fresh });
    expect(decideRound(err({ isAuth: true }), { discovered: false, downMs: 0, phase: "startup" })).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("check --token"),
    });
    // Remote non-auth at startup fails fast: nothing has ever succeeded on that endpoint.
    expect(decideRound(err(), { discovered: false, downMs: 0, phase: "startup" })).toMatchObject({ kind: "exit" });
    // Local startup grace: 15s of patience for the dev-watch restart window, then the honest exit.
    expect(decideRound(err(), { discovered: true, downMs: 14_000, phase: "startup" })).toMatchObject({
      kind: "retry",
      warn: expect.stringContaining("serve not ready"),
    });
    expect(decideRound(err(), { discovered: true, downMs: 15_000, phase: "startup" })).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("not yet started"),
    });
    // Empty clean rounds tick the same budget — a half-dead proxy must not loop forever.
    expect(decideRound({ type: "empty" }, { discovered: true, downMs: 0 })).toMatchObject({ kind: "retry" });
    expect(decideRound({ type: "empty" }, { discovered: true, downMs: 30_000 })).toMatchObject({
      kind: "exit",
      message: expect.stringContaining("nothing delivered"),
    });
  });

  it("attachRound buffers live output during the replay block and flushes it after, failure path included", async () => {
    const { attachRound } = await import("../src/cli/commands/attach.ts");
    const lines: string[] = [];
    const io = {
      println: (l: string) => lines.push(l),
      write: (c: string) => lines.push(`D:${c}`),
      warn: (l: string) => lines.push(`W:${l}`),
    };
    // The events stream produces IMMEDIATELY — before the backfill prints — then ends.
    const eagerEvents = () => ({
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<SessionEvent> {
        yield { type: "run_started", timestamp: 0, runId: "rL", data: {} };
      },
    });
    const fake = handleControl({
      state: async () => ({ status: "idle", pending: { steering: 0, followUp: 0 } }) as never,
      entries: async () =>
        ({
          entries: [{ id: "e1", timestamp: 1, kind: "assistant", data: { text: "replayed" } }],
          leafEntryId: "e1",
        }) as never,
      events: eagerEvents,
    });
    const buffered = await attachRound(fake as never, "s", undefined, io, 25);
    expect(buffered.sawProgress).toBe(true); // a live event arrived
    // Contiguity: the whole replay block (and the state line) precede the buffered live output.
    expect(lines).toEqual([
      "[replaying the record since the last sync (may overlap what you saw live)]",
      "replayed",
      "[end of replay]",
      "[live — idle]",
      "── run rL started ──",
    ]);

    // Failure path: buffered live output is released, not lost, before the error propagates.
    const lines2: string[] = [];
    const io2 = { ...io, println: (l: string) => lines2.push(l), warn: (l: string) => lines2.push(`W:${l}`) };
    const failing = handleControl({
      state: async () => ({ status: "idle", pending: { steering: 0, followUp: 0 } }) as never,
      events: eagerEvents,
      entries: async () => {
        await new Promise((r) => setTimeout(r, 30)); // let the eager event land in the buffer first
        throw new Error("backfill 500");
      },
    });
    await expect(attachRound(failing as never, "s", undefined, io2, 1)).rejects.toThrow(/backfill 500/);
    expect(lines2).toContain("── run rL started ──");
  });

  it("attachRound: renders the backfill, advances the cursor, and surfaces a 401 instead of retrying", async () => {
    const { attachRound } = await import("../src/cli/commands/attach.ts");
    const { ControlRequestError } = await import("../src/session-remote.ts");
    const lines: string[] = [];
    const io = {
      println: (l: string) => lines.push(l),
      write: (c: string) => lines.push(`D:${c}`),
      warn: (l: string) => lines.push(`W:${l}`),
    };
    const entriesPage = {
      entries: [
        { id: "e2", timestamp: 1, kind: "user", data: { text: "question" } },
        { id: "e3", parentId: "e2", timestamp: 2, kind: "assistant", data: { text: "answer" } },
      ],
      leafEntryId: "e3",
    };
    const quietEvents = (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: async function* () {},
    });
    const fake = handleControl({
      state: async () => ({ status: "idle", pending: { steering: 0, followUp: 0 } }) as never,
      entries: async (opts?: { since?: string }) => {
        expect(opts?.since).toBe("e1"); // the cursor travels into the backfill
        return entriesPage as never;
      },
      events: quietEvents,
    });
    const round = await attachRound(fake as never, "s", "e1", io, 1);
    expect(round.cursor).toBe("e3"); // advanced by append order
    expect(round.sawProgress).toBe(true); // the backfill delivered records
    expect(lines).toEqual([
      "[replaying the record since the last sync (may overlap what you saw live)]",
      "> question",
      "answer",
      "[end of replay]",
      "[live — idle]", // the reconnect protocol's state re-check, rendered
    ]);

    // A 401 from the stream is the round's 401 — thrown, not warn-and-retried.
    const auth = new ControlRequestError(401, "unauthorized");
    const failing = handleControl({
      state: async () => ({ status: "idle", pending: { steering: 0, followUp: 0 } }) as never,
      entries: async () => ({ entries: [] }) as never,
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<never>> => Promise.reject(auth),
        }),
      }),
    });
    await expect(attachRound(failing as never, "s", undefined, io, 1)).rejects.toBe(auth);

    // A backfill failure closes the round's OWN subscription before propagating — a retrying
    // caller must never stack a second concurrent stream.
    let returned = false;
    const leaky = handleControl({
      state: async () => ({ status: "idle", pending: { steering: 0, followUp: 0 } }) as never,
      entries: async () => {
        throw new Error("transient 500");
      },
      events: () => {
        // A quiet stream whose return() settles the pending next() — as the real client/hub do.
        let settle: ((r: IteratorResult<never>) => void) | undefined;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<never>>((res) => {
                settle = res;
              }),
            return: async () => {
              returned = true;
              settle?.({ done: true, value: undefined });
              return { done: true as const, value: undefined };
            },
          }),
        };
      },
    });
    await expect(attachRound(leaky as never, "s", undefined, io, 1)).rejects.toThrow(/transient 500/);
    expect(returned).toBe(true);

    // The SAME discipline for a state() re-check failure — the round's stream must close too.
    let returned2 = false;
    const stateFails = handleControl({
      entries: async () => ({ entries: [] }) as never,
      state: async () => {
        throw new Error("state 500");
      },
      events: () => {
        let settle: ((r: IteratorResult<never>) => void) | undefined;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<never>>((res) => {
                settle = res;
              }),
            return: async () => {
              returned2 = true;
              settle?.({ done: true, value: undefined });
              return { done: true as const, value: undefined };
            },
          }),
        };
      },
    });
    await expect(attachRound(stateFails as never, "s", undefined, io, 1)).rejects.toThrow(/state 500/);
    expect(returned2).toBe(true);
  });

  it("a malformed id segment is a 404 from the PLANE, not a throw past its boundary", async () => {
    // `decodeURIComponent` throws on a bad escape, and the match runs BEFORE the try that guards the
    // handlers — so this used to leave the boundary entirely: no CORS headers, no log, and a
    // rejected promise for an embedder mounting the handler directly. The query-parameter form this
    // replaced decoded leniently and could not throw, which is what made it a regression.
    const { control } = await fauxControlledAgent([]);
    const plane = createControlPlane(control, { token: TOKEN }).handler;
    for (const path of ["/control/sessions/100%", "/control/sessions/%E0%A4%A/entries"]) {
      const res = await plane(new Request(`http://x${path}`));
      expect(res.status).toBe(404);
      expect(res.headers.get("access-control-allow-origin")).toBe("*"); // it left through the exit
    }
  });

  it("a malformed body is a 400, never a 500 — including the ones that are not objects", async () => {
    const { control } = await fauxControlledAgent([]);
    const plane = createControlPlane(control, { token: TOKEN }).handler;
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    // `JSON.parse("null")` is null: reaching into it unguarded turned a malformed request into an
    // internal error the client cannot act on.
    for (const body of ["null", '"a string"', "42"]) {
      const res = await plane(new Request("http://x/control/sessions/abc", { method: "PUT", headers: auth, body }));
      expect(res.status).toBe(400);
    }
    // The PATCH parser already answered a protocol-level rejection for these; it still must.
    const patched = await plane(
      new Request("http://x/control/sessions/abc", { method: "PATCH", headers: auth, body: "null" }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ ok: false, error: { code: "invalid_command" } });
  });

  it("PATCH with an unknown field is refused at the wire, not answered ok with nothing written", async () => {
    // A client typo — or a newer client talking to an older serve — otherwise reads success for a
    // patch that set nothing. The action parser rejects an unknown `type` for the same reason.
    const { control } = await fauxControlledAgent([]);
    const plane = createControlPlane(control, { token: TOKEN }).handler;
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    // The code is the SAME one the in-process path answers: the wire must not be where a client
    // loses the difference between "drop that field" and "fix that value".
    const unknownField = await plane(
      new Request("http://x/control/sessions/s", { method: "PATCH", headers: auth, body: '{"nmae":"typo"}' }),
    );
    expect(unknownField.status).toBe(200);
    expect(await unknownField.json()).toMatchObject({
      ok: false,
      error: { code: UNSUPPORTED_CAPABILITY_CODE, message: expect.stringContaining("nmae") },
    });
    // A wrong VALUE type is the other answer — a malformed payload, not a missing feature.
    const wrongType = await plane(
      new Request("http://x/control/sessions/s", { method: "PATCH", headers: auth, body: '{"name":42}' }),
    );
    expect(await wrongType.json()).toMatchObject({ ok: false, error: { code: "invalid_command" } });
  });

  it("an id that is not a path segment fails VISIBLY, instead of addressing its neighbour", async () => {
    // Moving the id from `?session=` into a path segment subjects it to URL normalisation, which
    // `encodeURIComponent` does not prevent (the spec normalises `%2E` too). Measured before the
    // guard: `.` arrived as `/control/sessions` — 200 JSON, which the SSE reader ended as a silently
    // EMPTY event stream — and `..` arrived as `/control/` → 404, while the local hub answered a
    // normal state for the same id. Two different ways to lie, so the transport refuses instead.
    const served = await serveControl();
    try {
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });
      for (const id of ["", ".", ".."]) {
        // At the BINDING, not once per call: a caller sees it where it made the mistake.
        expect(() => remote.sessions.get(id)).toThrow(/cannot travel as a URL path segment/);
        // …and `fork`'s target is the same kind of path segment. Without this the local plane
        // answers invalid_command while the wire answers a 404 from a URL that normalised away.
        // It REJECTS rather than throwing: the method is typed `Promise`, and a caller may well have
        // written `.catch()` or handed it to `Promise.all`.
        await expect(remote.sessions.fork({ from: "s", at: "e", into: id })).rejects.toThrow(
          /cannot travel as a URL path segment/,
        );
        // …and the plane will not MINT one either: a fork target no client could open.
        const forked = await served.localControl.sessions.fork({ from: "s", at: "e", into: id });
        expect(forked.ok).toBe(false);
        if (!forked.ok) expect(forked.error.code).toBe("invalid_command");
      }
    } finally {
      served.close();
    }
  });

  it("createControlPlane refuses to mount without a token", async () => {
    const { control } = await fauxControlledAgent([]);
    expect(() => createControlPlane(control, { token: "" })).toThrow(/token is required/);
  });

  it("sessions() travels: the deployment's list, isomorphic local and remote", async () => {
    const served = await serveControl();
    try {
      await drain(served.agent.invoke({ session: "sList" }, { text: "hi" }));
      const remote = await connectSessionControl({ url: served.url, token: TOKEN });
      expect(await remote.sessions.list()).toEqual(await served.localControl.sessions.list());
      expect((await remote.sessions.list()).map((s) => s.session)).toEqual(["sList"]);
    } finally {
      await served.close();
    }
  });

  it("a store FAULT is a coded 503; anything else is a 500 the operator can see", async () => {
    // #309's lesson, one route over: an uncoded failure is indistinguishable from an unreachable
    // endpoint, so a client burns its reconnect budget on a condition reconnecting cannot fix. The
    // inverse matters too — a bug of OURS answered `retryable: true` would have it poll forever.
    const { control } = await fauxControlledAgent([]);
    const ioError = Object.assign(new Error("EACCES: permission denied, scandir '/data/.state'"), { code: "EACCES" });
    const broken = (thrown: unknown): typeof control => ({
      ...control,
      sessions: {
        ...control.sessions,
        list: async () => {
          throw thrown;
        },
      },
    });
    const logged: string[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation((line: string) => void logged.push(line));
    try {
      const faulty = serveNode(router({}, [createControlPlane(broken(ioError), { token: TOKEN })]), { port: 0 });
      const faultyPort = await faulty.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${faultyPort}/control/sessions`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code: SESSIONS_UNAVAILABLE_CODE, retryable: true });
        expect(logged.join("\n")).toMatch(/EACCES/); // and the operator sees it, not just the client

        // And the client can READ that code — the whole point of carrying it on the wire.
        const remote = await connectSessionControl({ url: `http://127.0.0.1:${faultyPort}`, token: TOKEN });
        await expect(remote.sessions.list()).rejects.toMatchObject({ code: SESSIONS_UNAVAILABLE_CODE, status: 503 });
      } finally {
        await faulty.close();
      }

      // A TypeError from our own row building is a BUG: it goes back to the plane's boundary, which
      // logs it and answers 500 — never `retryable: true`, which would have a client poll forever.
      const buggy = serveNode(
        router({}, [createControlPlane(broken(new TypeError("rows.map is not a function")), { token: TOKEN })]),
        { port: 0 },
      );
      const buggyPort = await buggy.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${buggyPort}/control/sessions`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(500);
        expect(logged.join("\n")).toMatch(/rows\.map is not a function/);
      } finally {
        await buggy.close();
      }

      // Node's OWN argument validation throws TypeErrors carrying a string `code`, so "has a code"
      // was not the test the comment above claims: an errno SHAPE is.
      const nodeBug = Object.assign(new TypeError('The "path" argument must be of type string'), {
        code: "ERR_INVALID_ARG_TYPE",
      });
      const misread = serveNode(router({}, [createControlPlane(broken(nodeBug), { token: TOKEN })]), { port: 0 });
      const misreadPort = await misread.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${misreadPort}/control/sessions`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(500);
      } finally {
        await misread.close();
      }

      // And a thrown null reaches the boundary as ITSELF, not as a TypeError from reading `.code`.
      const nothing = serveNode(router({}, [createControlPlane(broken(null), { token: TOKEN })]), { port: 0 });
      const nothingPort = await nothing.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${nothingPort}/control/sessions`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(500);
        expect(logged.join("\n")).not.toMatch(/Cannot read propert/);
      } finally {
        await nothing.close();
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// ── SPEC conformance for the REMOTE Agent ────────────────────────────────────
// connectAgent claims to be "a REAL Agent, failure discipline included" — so it runs the same
// executable SPEC the reference engine does. Each posture serves a real HTTP server; the wire is in
// the loop for every MUST (incl. MUST 3: a consumer break must abort the fetch AND release the
// server-side engine work).

const conformanceServers: Array<() => void> = [];
afterAll(() => {
  for (const close of conformanceServers) close();
});

/** A served agent in a caller-chosen posture, plus its remote client. */
async function serveRemoteAgent(opts: {
  responses?: FauxResponseStep[];
  tools?: AgentTool[];
  /** Replace the engine binding entirely — the setup-failure posture. */
  sessionFactory?: PiAgentSessionFactory;
}): Promise<ReturnType<typeof connectAgent>> {
  const sessions = piInMemorySessionRecordStore({ cwd: process.cwd() });
  const lease = inProcessLease();
  const { control, observer } = createPiSessionControl({ sessions });
  const agent = opts.sessionFactory
    ? createPiAgentFromSession({ observer, lease, sessionFactory: opts.sessionFactory })
    : fauxAgent(opts.responses ?? [], { sessions, lease, observer, tools: opts.tools ?? [] }).agent;
  const server = serveNode(router({}, [createControlPlane(control, { token: TOKEN, agent })]), { port: 0 });
  const port = await server.listening;
  conformanceServers.push(() => server.close());
  return connectAgent({ url: `http://127.0.0.1:${port}`, token: TOKEN });
}

describeSpecConformance("remote agent over /control/invoke", {
  completing: () => serveRemoteAgent({ responses: [fauxAssistantMessage("spec ok")] }),
  failing: () =>
    serveRemoteAgent({
      sessionFactory: async () => {
        throw new Error("engine setup exploded");
      },
    }),
  hanging: (onCleanup) => {
    const hangTool: AgentTool = {
      name: "hang",
      label: "h",
      description: "hangs until aborted",
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        await new Promise<never>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              onCleanup(); // the engine's in-flight work was actually released
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return { content: [], details: {} };
      },
    };
    return serveRemoteAgent({
      responses: [fauxAssistantMessage(fauxToolCall("hang", {}, { id: "h1" }))],
      tools: [hangTool],
    });
  },
});
