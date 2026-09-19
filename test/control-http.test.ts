/**
 * Transport conformance — docs/design/session-control.md §13: the HTTP+SSE wire protocol
 * (`createControlPlane`) and the remote client (`connectSessionControl`) are exercised TOGETHER over a
 * real node:http server against a real hub + faux agent: local and remote `SessionControl` must be
 * isomorphic (same interface, same answers), the envelope must be consumed internally (epoch/seq
 * never reach the consumer), and every route must answer WITHOUT a credential — fastagent authenticates
 * nothing, by design (the deployment does).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { controlPlaneRoutes, createControlPlane, mountControlPlane } from "../src/channels/control.ts";
import { createInvokeHandler } from "../src/channels/http.ts";
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
  const plane = createControlPlane(control);
  // BOTH planes, as a real serve has them: the DATA plane at the root, control under its prefix.
  const server = serveNode(router({ unverified: { "POST /invoke": createInvokeHandler(agent) }, mounts: [plane] }), {
    port: 0,
  });
  const port = await server.listening;
  return {
    agent,
    commandList,
    // The plane's OWN routes: the mount point is one wildcard key, so sweeps derive from here.
    routeKeys: Object.keys(controlPlaneRoutes(control)),
    localControl: control,
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    spec: `${faux.getModel().provider}/${faux.getModel().id}`,
  };
}

/**
 * THE fake control-plane `fetch`, because a hand-written one keeps forgetting the same clause.
 *
 * A real `fetch` ends its work when the caller aborts: the promise rejects, or the body errors. A fake that ignores
 * `init.signal` still SERVES every test that only reads bytes — and silently reports "pass" for every claim about
 * when the client does or does not tear a connection down. Two such fakes existed here, and under a mutation that
 * killed healthy connections both stayed green. So the contract lives in one place that cannot forget it, and the
 * knobs below are the only things a caller may vary.
 */
function fakeSse(options: { status?: number; blocks?: string[] } = {}): {
  fetchFn: typeof fetch;
  /** Feed one SSE block. Before anything connects it is QUEUED, so a test never has to know when the client's first
   *  pull reaches the fetch. Unusable with `blocks`, which delivers its own and closes the stream. */
  push(block: string): void;
} {
  const encoder = new TextEncoder();
  const queued: string[] = [];
  let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/control/capabilities")) {
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    // The other half of the clause: a signal that is ALREADY aborted never reaches a listener, and a real fetch
    // rejects on the spot rather than opening anything.
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller;
        for (const block of [...queued.splice(0), ...(options.blocks ?? [])]) {
          controller.enqueue(encoder.encode(block));
        }
        if (options.blocks) controller.close();
        // THE clause: a body outlives its caller only until the caller says stop.
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body, {
      status: options.status ?? 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return {
    fetchFn,
    push: (block) => (feed ? feed.enqueue(encoder.encode(block)) : void queued.push(block)),
  };
}

/** A `fetch` whose connect never completes — the black hole no request timeout used to cover. */
function fakeUnreachable(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/control/capabilities")) {
      return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
    }
    if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
    return new Promise<Response>((_resolve, reject) => {
      // Same clause: an endpoint that never answers still lets go when the caller does.
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), {
        once: true,
      });
    });
  }) as typeof fetch;
}

/** A control whose per-session calls are the ones given — the handle shape, faked: a caller reaches a session
 *  through the hub, so a fake has to have that shape too. */
function handleControl(session: Record<string, unknown>): never {
  return {
    capabilities: () => ({}) as never,
    commands: async () => [],
    sessions: { list: async () => [], fork: async () => ({ ok: true }), get: () => session },
  } as never;
}

/** Any origin; the cross-origin default is `*` unless `http.cors` narrows it (channels/serve.ts). */
const LOCAL_ORIGIN = "http://localhost:5173";
const fromBrowser = { origin: LOCAL_ORIGIN };
/** What the default answers a browser with. */
const ALLOWED = "*";

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("session control over HTTP", () => {
  it("serves every route unauthenticated — no credential is invented, and none is demanded", async () => {
    const served = await serveControl();
    try {
      // DERIVED from the routes this server actually MOUNTS, so a route added later is swept too. The
      // claim is the deliberate one: fastagent authenticates nothing, so NOTHING here may answer 401.
      // An `Authorization` header is carried on the second pass because a deployment that fronts this
      // port with a gateway sends one, and a route that choked on it would break that deployment.
      expect(served.routeKeys).toContain("GET /control/commands"); // the sweep sees the whole table
      for (const key of served.routeKeys) {
        const [method, path] = key.split(" ") as [string, string];
        const url = `${served.url}${path.replace("{session}", "s")}?session=s`;
        for (const headers of [undefined, { authorization: "Bearer anything" }]) {
          const res = await fetch(url, { method, body: method === "POST" ? "{}" : undefined, headers });
          expect({ key, status: res.status }).not.toEqual({ key, status: 401 });
          expect({ key, status: res.status }).not.toEqual({ key, status: 403 });
        }
      }
      // The DATA plane answers the same way — it is the route the control plane's invoke used to hide behind.
      const invoked = await fetch(`${served.url}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: "unauth", text: "hi" }),
      });
      expect(invoked.status).toBe(200);
      await invoked.body?.cancel();
      await expect(connectSessionControl({ url: served.url })).resolves.toBeTruthy();
    } finally {
      served.close();
    }
  });

  it("fetchFn is the transport seam: a gateway credential rides every request, streams included", async () => {
    // fastagent authenticates nothing and the docs say to front the serve, so satisfying that gateway
    // has to have a supported path. A `headers` option was tried and removed: it covered only the
    // static-token case this already covers, and an IdP proxy needs the refresh it could not express.
    const seen: (string | undefined)[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? undefined);
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/events")) {
        return new Response(
          `data: ${JSON.stringify({ sessionId: "s", epoch: "e", seq: 0, event: { type: "idle" } })}\n\n`,
        );
      }
      if (path === "/invoke") return new Response(`data: ${JSON.stringify({ type: "completed" })}\n\n`);
      return Response.json(path === "/control/capabilities" ? { commands: [], models: [] } : { ok: true });
    };
    const authed: typeof fetch = (input, init) =>
      fetchFn(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: "Bearer gw" },
      });
    const remote = await connectSessionControl({ url: "http://gw", fetchFn: authed });
    await remote.sessions.get("s").abort();
    await remote.sessions.get("s").events()[Symbol.asyncIterator]().next();
    await drain(connectAgent({ url: "http://gw", fetchFn: authed }).invoke({ session: "s" }, { text: "hi" }));
    expect(seen.length).toBeGreaterThanOrEqual(4); // capabilities, the write, the events stream, invoke
    expect(seen.filter((h) => h !== "Bearer gw")).toEqual([]);
  });

  it("the control plane's writes need a declared JSON body too — one gate, both planes", async () => {
    // The same cross-origin simple-request gate as `POST /invoke` (test/http.test.ts explains why).
    // Checked here because this plane's reader treats an EMPTY body as `{}`, so a gate conditioned on
    // "has a body" would let a body-less cross-origin POST steer or abort a running turn.
    const served = await serveControl();
    try {
      for (const init of [
        { method: "POST", headers: { "content-type": "text/plain" }, body: '{"type":"abort"}' },
        { method: "POST" }, // no body at all
      ] as const) {
        const res = await fetch(`${served.url}/control/sessions/s/actions`, init);
        expect({ init: init.headers ? "text/plain" : "none", status: res.status }).toEqual({
          init: init.headers ? "text/plain" : "none",
          status: 415,
        });
      }
      // Reads are untouched: a cross-origin GET has no side effect, and the browser cannot read it.
      expect((await fetch(`${served.url}/control/capabilities`)).status).toBe(200);
    } finally {
      served.close();
    }
  });

  it("preserves the HTTP failure when its JSON error body is null", async () => {
    await expect(
      connectSessionControl({
        url: "http://x",
        fetchFn: async () => Response.json(null, { status: 503 }),
      }),
    ).rejects.toMatchObject({ status: 503, message: "control request failed: 503 null" });
  });

  it("a browser on this machine can reach both planes: preflight, CORS headers on every answer", async () => {
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
      // DERIVED from what the server MOUNTS: a route added later cannot ship browser-unreachable,
      // and a POST route is checked as a POST route. `POST /invoke` is in the sweep because the
      // preflight for it is what a route table registering only POST cannot answer by itself —
      // the router has to, and that is the regression this pins.
      expect(served.routeKeys).toContain("POST /control/sessions/{session}/actions");
      for (const key of [...served.routeKeys, "POST /invoke"]) {
        const [method, path] = key.split(" ") as [string, string];
        // What the browser would actually name: a JSON body is NOT a safelisted content-type, so
        // every POST preflight carries it, and a fronted deployment adds `authorization`.
        const requested = method === "POST" ? ["authorization", "content-type"] : ["authorization"];
        const res = await fetch(`${served.url}${path.replace("{session}", "s")}`, {
          method: "OPTIONS",
          headers: {
            ...fromBrowser,
            "access-control-request-method": method,
            "access-control-request-headers": requested.join(", "),
          },
        });
        // The ORIGIN is echoed, never `*`: the allowance is for this browser, and `vary: origin`
        // keeps a cache from handing the verdict to a different one.
        expect({ path: key, status: res.status, origin: origin(res) }).toEqual({
          path: key,
          status: 204,
          origin: ALLOWED,
        });
        expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
        expect({ path: key, ...permits(res, method, requested) }).toEqual({
          path: key,
          method: true,
          headers: true,
        });
      }

      // A rejected or failing call must stay READABLE: without the headers the browser hands the
      // client an opaque network error instead of the status that says what went wrong.
      expect(origin(await fetch(`${served.url}/control/capabilities`, { headers: fromBrowser }))).toBe(ALLOWED);
      expect(origin(await fetch(`${served.url}/control/sessions/s`, { headers: fromBrowser }))).toBe(ALLOWED);
      // SSE too — the long-lived route a GUI actually renders from.
      const sse = await fetch(`${served.url}/control/sessions/s/events`, { headers: fromBrowser });
      expect(sse.headers.get("content-type")).toBe("text/event-stream");
      expect(origin(sse)).toBe(ALLOWED);
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
        headers: { ...fromBrowser, "access-control-request-method": method },
      });
      const allowed = (pre.headers.get("access-control-allow-methods") ?? "")
        .split(",")
        .map((m) => m.trim().toUpperCase());
      return (
        pre.status === 204 && pre.headers.get("access-control-allow-origin") === ALLOWED && allowed.includes(method)
      );
    };
    try {
      // An unknown path under the prefix, and a known path under a method it does not serve.
      expect(await browserWouldSend("GET", "/control/nonexistent")).toBe(true);
      expect(await browserWouldSend("GET", "/control/sessions/s/actions")).toBe(true);
      // ...and only because the gate opens do the plane's own answers become readable.
      expect((await fetch(`${served.url}/control/nonexistent`, { headers: fromBrowser })).status).toBe(404);
      expect((await fetch(`${served.url}/control/sessions/sW/actions`, { headers: fromBrowser })).status).toBe(405);
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
      // 1. A path under the prefix that no route serves. 404 (not 405) is load-bearing: a remote
      //    client reads it as "this serve predates the route", i.e. version skew, not a fault.
      const unknown = await fetch(`${served.url}/control/nonexistent`, { headers: fromBrowser });
      expect({ status: unknown.status, cors: cors(unknown) }).toEqual({ status: 404, cors: ALLOWED });
      // 2. A known path under a method it does not serve.
      const wrongMethod = await fetch(`${served.url}/control/sessions/sW/actions`, { headers: fromBrowser });
      expect({ status: wrongMethod.status, cors: cors(wrongMethod) }).toEqual({ status: 405, cors: ALLOWED });
      // 3. Outside the prefix stays the HOST's business — the plane must not answer for the whole
      //    server, only for what it owns.
      expect((await fetch(`${served.url}/not-control`)).status).toBe(404);
      // 3b. The plane's own 404 carries no content for HEAD. Asserted at the handler: over a socket
      //     Node suppresses a HEAD body itself, so going through fetch would prove nothing.
      const { control: quiet } = await fauxControlledAgent([]);
      const plane = mountControlPlane(controlPlaneRoutes(quiet)).handler;
      const headMissing = await plane(new Request("http://x/control/nope", { method: "HEAD" }));
      expect(headMissing.status).toBe(404);
      expect(await headMissing.text()).toBe("");
      // 4. A percent-encoded spelling is a DIFFERENT path, answered like any other unknown one —
      //    and still readably. Paths are matched as they arrive: decoding them first would undo the
      //    normalisation `URL` already performed, turning `%2F..%2F` back into `/../`. No client
      //    sends these (the remote client percent-encodes session ids into a path segment).
      const encoded = await fetch(`${served.url}/control/%63apabilities`, { headers: fromBrowser });
      expect({ status: encoded.status, cors: cors(encoded) }).toEqual({ status: 404, cors: ALLOWED });
      // 5. A HEAD the plane will actually serve must not be refused by its own advertisement.
      const headable = await fetch(`${served.url}/control/capabilities`, { method: "HEAD" });
      const getable = await fetch(`${served.url}/control/capabilities`);
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
    const server = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(control)] }), { port: 0 });
    const port = await server.listening;
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/commands`, { headers: fromBrowser });
      expect(res.status).toBe(500);
      expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
      // Failing visibly is not optional just because the client now gets a readable status.
      expect(errors.mock.calls.map(String).join("\n")).toMatch(/permission denied/);
      // ...and the internal message stays internal.
      expect(await res.text()).not.toMatch(/permission denied/);
    } finally {
      errors.mockRestore();
      server.close();
    }
  });

  it("a synchronous subscription failure returns HTTP 500 through the real server", async () => {
    const control = handleControl({
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next() {
            throw new Error("subscription setup failed");
          },
        }),
      }),
    });
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    const server = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(control)] }), { port: 0 });
    try {
      const url = `http://127.0.0.1:${await server.listening}`;
      const res = await fetch(`${url}/control/sessions/s/events`, { headers: fromBrowser });
      expect(res.status).toBe(500);
      expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
      expect(await res.text()).toBe("internal error\n");
      const remote = await connectSessionControl({ url });
      const iterator = remote.sessions.get("s").events()[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({ status: 500 });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("subscription setup failed"));
    } finally {
      await server.close();
      errors.mockRestore();
    }
  });

  it("both hand-kept route tables list every route the plane mounts", () => {
    // TWO copies of the route list exist outside the code: \u00a713, which the multi-tenant facade in
    // \u00a714 is written against (a route missing there is a route nobody guards), and the curl table in
    // api-reference, which is what a non-TypeScript client builds from. Both are derived from the
    // mount here, so adding a route without documenting it fails in whichever copy forgot it.
    const section = (file: string, from: string, to: string): string => {
      const doc = readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8");
      const start = doc.indexOf(from);
      const end = doc.indexOf(to, start + 1);
      // Renumbering or retitling either bound would leave `slice` scanning past the table, turning
      // this into a check that passes on text it never read.
      expect([start, end], `${file}: could not locate the table between ${from} and ${to}`).not.toContain(-1);
      return doc.slice(start, end);
    };
    const documented = (text: string): Set<string> =>
      new Set(
        [...text.matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/control\/\S*)/gm)].map(
          ([, method, path]) => `${method} ${(path as string).replace("{id}", "{session}")}`,
        ),
      );
    const tables = {
      "design/session-control.md \u00a713": documented(section("design/session-control.md", "## 13.", "## 14.")),
      "api-reference.md (curl)": documented(section("api-reference.md", "a `curl` away", "```\n\n")),
    };
    const mounted = Object.keys(controlPlaneRoutes(handleControl({})));
    for (const [where, listed] of Object.entries(tables))
      for (const key of mounted) expect(listed, `${key} is mounted but missing from ${where}`).toContain(key);
  });

  it("local and remote are isomorphic: capabilities/state/entries/dispatch answer identically", async () => {
    const served = await serveControl();
    try {
      await drain(served.agent.invoke({ session: "sW" }, { text: "hi" }));
      const remote = await connectSessionControl({ url: served.url });

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
      Object.entries(controlPlaneRoutes(control)).filter(([key]) => !key.endsWith(" /control/commands")),
    );
    const server = serveNode(router({ selfVerifying: {}, mounts: [mountControlPlane(withoutCommands)] }), { port: 0 });
    const port = await server.listening;
    try {
      const remote = await connectSessionControl({ url: `http://127.0.0.1:${port}` });
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
      const remote = await connectSessionControl({ url: served.url });
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
      const remote = await connectSessionControl({ url: served.url });
      const seen: SessionEvent[] = [];
      const stream = remote.sessions.get("sE").events();
      const watching = (async () => {
        for await (const ev of stream) {
          seen.push(ev);
          if (ev.type === "run_settled") break;
        }
      })();
      // The subscription race, ANSWERED rather than slept on: the server subscribes before it writes the response
      // headers, so `ready` settling means every event from here on is ours — on an idle session that emits nothing
      // to wait for, which is the case a "wait for the first event" rule cannot serve.
      await stream.ready;
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
      const remote = await connectSessionControl({ url: served.url });
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
    const server = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(control)] }), { port: 0 });
    const port = await server.listening;
    try {
      const post = (command: unknown) =>
        fetch(`http://127.0.0.1:${port}/control/sessions/sImg/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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
    const server = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(control)] }), { port: 0 });
    const port = await server.listening;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/commands`, {});
      expect(res.ok).toBe(false);
      expect(res.status).toBeGreaterThanOrEqual(500);
      const { ControlRequestError } = await import("../src/session-remote.ts");
      const remote = await connectSessionControl({ url: `http://127.0.0.1:${port}` });
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
        headers: { "content-type": "application/json" },
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

  it("the remote data plane: connectAgent drives a run through /invoke, observed via events", async () => {
    const served = await serveControl();
    try {
      const remote = await connectSessionControl({ url: served.url });
      const remoteAgent = connectAgent({ url: served.url });
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
      // An endpoint with no data plane is the ordinary way to be pointed at the wrong thing.
      const wrong = connectAgent({ url: `${served.url}/nope` });
      const missing = await drain(wrong.invoke({ session: "x" }, { text: "hi" }));
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ type: "failed", retryable: false });
      expect((missing[0] as { details: string }).details).toContain("404");
      const withImages = await drain(
        remoteAgent.invoke({ session: "x" }, { text: "hi", images: [{ mimeType: "image/png", data: "x" }] }),
      );
      expect(withImages).toEqual([expect.objectContaining({ type: "failed", retryable: false })]);
      expect((withImages[0] as { details: string }).details).toContain("images");
    } finally {
      served.close();
    }
  });

  it("remote invoke stops at its terminal and releases the connection", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchFn: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      const events = [{ type: "completed" }, { type: "text", delta: "too late" }, { type: "completed" }];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    };
    const agent = connectAgent({ url: "http://x", fetchFn });
    expect(await drain(agent.invoke({ session: "s" }, { text: "hi" }))).toEqual([{ type: "completed" }]);
    expect(signal?.aborted).toBe(true);
  });

  it("the control plane is PURE control: no invoke route lives under its prefix", async () => {
    const { control } = await fauxControlledAgent([], { boundary: false });
    const server = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(control)] }), { port: 0 });
    const port = await server.listening;
    try {
      // Running a turn belongs to the DATA plane (`POST /invoke`). This prefix used to carry a duplicate of it
      // whose only difference was the bearer token that no longer exists.
      expect(Object.keys(controlPlaneRoutes(control))).not.toContain("POST /control/invoke");
      const res = await fetch(`http://127.0.0.1:${port}/control/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
      // A boundary-less hub still speaks the protocol on the wire: a boundary command answers
      // HTTP 200 + unsupported_capability, never a transport error.
      const dispatch = await fetch(`http://127.0.0.1:${port}/control/sessions/s/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

  it("a black-holed CONNECT is terminated on both streaming planes, each on its caller's budget", async () => {
    // fetch never resolves unless aborted — the connect-phase window no request timeout covers.
    const blackHole = fakeUnreachable();
    const fakeTimers = await import("vitest").then((m) => m.vi);
    fakeTimers.useFakeTimers();
    try {
      const remote = await connectSessionControl({ url: "http://hole", fetchFn: blackHole });
      // The rejection assertion attaches AT CREATION: the promise rejects while timers advance,
      // and a handler attached only afterwards would leave an unhandled-rejection window vitest
      // reports as a run-level error — noise that trains everyone to ignore the real ones.
      const stream = remote.sessions.get("s").events();
      const eventsAttempt = expect(
        (async () => {
          for await (const _ of stream) void _;
        })(),
      ).rejects.toThrow(/no usable response in 10s/);
      // A reconnecting client WAITS on this phase before it reads history, so the connect gets the same 10s
      // black-hole budget as any other request — the 90s heartbeat limit is for a connection that is merely quiet.
      const readyAttempt = expect(stream.ready).rejects.toThrow(/no usable response in 10s/);
      const agentAttempt = drain(
        connectAgent({ url: "http://hole", fetchFn: blackHole }).invoke({ session: "s" }, { text: "hi" }),
      );
      await fakeTimers.advanceTimersByTimeAsync(10_000);
      await eventsAttempt;
      await readyAttempt;
      // The invoke plane connects through the same phase with its own limit: it used to have NO connect budget at
      // all (it waited out the 90s idle limit for a connection that had not even answered), and it must not inherit
      // the events plane's 10s either — a scale-to-zero host holds a POST open while the machine boots.
      await fakeTimers.advanceTimersByTimeAsync(50_000);
      const agentEvents = await agentAttempt;
      expect(agentEvents).toEqual([
        expect.objectContaining({
          type: "failed",
          retryable: true,
          details: expect.stringContaining("no usable response in 60s"),
        }),
      ]);
    } finally {
      fakeTimers.useRealTimers();
    }
  });

  it("4xx headers with a black-holed BODY stay on the connect budget, and a cancelled connect says so", async () => {
    // The half-dead tunnel the error path names: headers answer, the body never does. Clearing the connect deadline
    // at the headers would have left that read to the 90s idle limit — with `ready` awaited before the backfill,
    // that is a whole client round spent silent.
    const { fetchFn: hangingBody } = fakeSse({ status: 502 }); // headers answer, the body never does
    const timers = await import("vitest").then((m) => m.vi);
    timers.useFakeTimers();
    try {
      const remote = await connectSessionControl({ url: "http://tunnel", fetchFn: hangingBody });
      const stream = remote.sessions.get("s").events();
      const iterating = expect(
        (async () => {
          for await (const _ of stream) void _;
        })(),
      ).rejects.toThrow(/no usable response in 10s/);
      const readyAttempt = expect(stream.ready).rejects.toThrow(/no usable response in 10s/);
      // The invoke plane opens through the SAME phase, so the tunnel cannot hold it open forever either — it used to
      // fall back to the 90s idle limit here, because the two planes were two copies of one sequence.
      const invoked = drain(
        connectAgent({ url: "http://tunnel", fetchFn: hangingBody }).invoke({ session: "s" }, { text: "x" }),
      );
      await timers.advanceTimersByTimeAsync(10_000);
      await iterating;
      await readyAttempt;
      await timers.advanceTimersByTimeAsync(50_000);
      expect(await invoked).toEqual([
        expect.objectContaining({ type: "failed", details: expect.stringContaining("no usable response in 60s") }),
      ]);
    } finally {
      timers.useRealTimers();
    }

    // A consumer that walks away before connecting ends its ITERATION cleanly (that is not a failure), but `ready`
    // has a promise it cannot keep — and it must say WHY it cannot keep it, not report an unreachable endpoint. The
    // two readers disagree on purpose, and they read the same stated reason to do it.
    const never = fakeUnreachable();
    const remote = await connectSessionControl({ url: "http://quiet", fetchFn: never });
    const stream = remote.sessions.get("s").events();
    const cancelled = expect(stream.ready).rejects.toThrow(/cancelled by the consumer/);
    const iterator = stream[Symbol.asyncIterator]();
    const pull = iterator.next();
    await iterator.return?.(undefined);
    expect(await pull).toMatchObject({ done: true });
    await cancelled;

    // …and the harder shape: walking away WITHOUT ever pulling. A generator that was never started does not run its
    // body on `return()`, so nothing inside it can settle `ready` — this used to hang, which is the one outcome a
    // caller cannot diagnose, and the local hub rejects it (session-control.test.ts owns that half).
    const untouched = remote.sessions.get("s").events();
    const neverPulled = untouched[Symbol.asyncIterator]();
    await neverPulled.return?.(undefined);
    await expect(untouched.ready).rejects.toThrow(/cancelled by the consumer/);
  });

  it("the connect limit ends WITH the connect: a heartbeating stream survives long past it", async () => {
    // One mechanism, two limits — and the switch is the whole point. Keeping the 10s connect limit on a subscribed
    // stream would kill every healthy connection, since the server only heartbeats every 30s.
    const timers = await import("vitest").then((m) => m.vi);
    timers.useFakeTimers();
    try {
      const { fetchFn: heartbeating, push } = fakeSse();
      const remote = await connectSessionControl({ url: "http://slow", fetchFn: heartbeating });
      const stream = remote.sessions.get("s").events();
      const seen: SessionEvent[] = [];
      // The iterator is HELD: releasing the connection means returning the one that opened it, and a fresh
      // `stream[Symbol.asyncIterator]()` would have been a different (unstarted) one — the connection and its idle
      // timer would have outlived the test.
      const iterator = stream[Symbol.asyncIterator]();
      const watching = (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          seen.push(next.value);
        }
      })();
      await stream.ready;
      // Quiet for three times the connect limit, with only the heartbeats a real server sends.
      for (let i = 0; i < 3; i++) {
        await timers.advanceTimersByTimeAsync(30_000);
        push(": ping\n\n");
        await timers.advanceTimersByTimeAsync(0);
      }
      push(`data: ${JSON.stringify({ seq: 0, event: { type: "run_started", timestamp: 0, data: {} } })}\n\n`);
      await timers.advanceTimersByTimeAsync(0);
      expect(seen.map((e) => e.type)).toEqual(["run_started"]); // still alive after 90s of heartbeat-only traffic
      await iterator.return?.(undefined);
      await watching; // the connection is actually released — a clean end, not a dangling stream
    } finally {
      timers.useRealTimers();
    }
  });

  it("a paused consumer never trips the watchdog — it measures pending reads, not pull progress", async () => {
    // A generator parked at yield (rate-limited rendering, a debugger) has NO pending read; the
    // healthy connection must not be misdiagnosed as dead — on the invoke plane that abort would
    // cancel the run the stream drives.
    const fakeTimers = await import("vitest").then((m) => m.vi);
    const { fetchFn, push } = fakeSse();
    const wire = (seq: number, event: object) =>
      `data: ${JSON.stringify({ sessionId: "s", epoch: "e", seq, event })}\n\n`;
    fakeTimers.useFakeTimers();
    try {
      const remote = await connectSessionControl({ url: "http://x", fetchFn });
      const iterator = remote.sessions.get("s").events()[Symbol.asyncIterator]();
      push(wire(0, { type: "run_started", timestamp: 1, data: {} }));
      expect(((await iterator.next()).value as SessionEvent).type).toBe("run_started");
      // The consumer pauses far past the idle limit — no pending read, watchdog disarmed.
      await fakeTimers.advanceTimersByTimeAsync(4 * 30_000);
      // Resume: the connection was never killed; the next event flows.
      const resumed = iterator.next();
      push(wire(1, { type: "run_settled", timestamp: 2, data: { status: "completed" } }));
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
    const routes = controlPlaneRoutes(quietControl);
    // The two SSE surfaces of the two PLANES: control's events route and the data plane's own handler.
    const invokeHandler = createInvokeHandler(quietAgent);
    fakeTimers.useFakeTimers();
    try {
      const eventsRoute = routes["GET /control/sessions/{session}/events"];
      if (!eventsRoute) throw new Error("routes missing");
      for (const [name, res] of [
        [
          "events",
          await eventsRoute(
            new Request("http://x/control/sessions/s/events"),
            new URL("http://x/control/sessions/s/events"),
            "s",
          ),
        ],
        [
          "invoke",
          await invokeHandler(
            new Request("http://x/invoke", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: "s", text: "hi" }),
            }),
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
    const makeFetch = (body: string) => fakeSse({ blocks: [body] }).fetchFn;
    // Valid JSON, wrong shape (a foreign SSE endpoint) — and plain non-JSON: both THROW so a
    // consumer's failure budget applies; reconnecting can never fix a protocol mismatch.
    for (const body of [
      'data: {"hello":"world"}\n\n',
      "data: not json at all\n\n",
      "data: null\n\n",
      'data: {"seq":0,"event":{}}\n\n',
    ]) {
      const remote = await connectSessionControl({ url: "http://fake", fetchFn: makeFetch(body) });
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
    const { fetchFn } = fakeSse({ blocks: sse });
    const remote = await connectSessionControl({ url: "http://fake", fetchFn });
    const seen: string[] = [];
    // The gap THROWS (same discipline as protocol mismatch) after yielding everything before it:
    // the consumer's failure path owns the diagnostic and its budget ticks.
    const iterate = async () => {
      for await (const ev of remote.sessions.get("s").events()) seen.push(ev.type);
    };
    await expect(iterate()).rejects.toThrow(/sequence gap/);
    expect(seen).toEqual(["run_started"]);
  });

  it("mountSessionControl merges routes and refuses a channel route under the plane's prefix", async () => {
    const { assertNoControlPlaneCollision, mountSessionControl } = await import("../src/service.ts");
    {
      const { control } = await fauxControlledAgent([]);
      const base = { "GET /health": () => new Response("ok") };
      const mounted = mountSessionControl(base, control);
      // The plane is a MOUNT, not a route entry: routes stay the channel's literal paths, and the
      // plane arrives beside them owning a prefix. That separation is what keeps every collision
      // check a comparison instead of a prediction about the matcher.
      expect(Object.keys(mounted.routes)).toEqual(["GET /health"]);
      expect(mounted.mounts.map((m) => m.prefix)).toEqual(["/control"]);
      // Collision is PREFIX-level: the plane owns everything under it, so a channel route landing
      // anywhere beneath is shadowed — including a path the plane does not itself serve.
      expect(() => mountSessionControl({ "/control/sessions": () => new Response("x") }, control)).toThrow(
        /collide with the session control plane/,
      );
      // A path the plane does NOT serve is the sharper case: string equality misses it, and the
      // channel then goes dark against the plane's own 404 with nothing reported.
      expect(() => mountSessionControl({ "GET /control/mine": () => new Response("x") }, control)).toThrow(
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
      expect(mounted.controlPrefix).toBe("/control");
      // Without a hub: passthrough, nothing mounted.
      const off = mountSessionControl(base, undefined);
      expect(off.routes).toBe(base);
      expect(off.controlPrefix).toBeUndefined();
    }
  });

  it("a malformed id segment is a 404 from the PLANE, not a throw past its boundary", async () => {
    // `decodeURIComponent` throws on a bad escape, and the match runs BEFORE the try that guards the
    // handlers — so this used to leave the boundary entirely: a rejected promise for an embedder
    // mounting the handler directly. The query-parameter form this replaced decoded leniently and
    // could not throw, which is what made it a regression.
    const { control } = await fauxControlledAgent([]);
    const plane = createControlPlane(control).handler;
    const served = router({ selfVerifying: {}, mounts: [createControlPlane(control)] });
    for (const path of ["/control/sessions/100%", "/control/sessions/%E0%A4%A/entries"]) {
      expect((await plane(new Request(`http://x${path}`))).status).toBe(404);
      // …and through the host router it is readable by a browser, like every other reply it owns.
      const res = await served(new Request(`http://x${path}`, { headers: fromBrowser }));
      expect(res.status).toBe(404);
      expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    }
  });

  it("a malformed body is a 400, never a 500 — including the ones that are not objects", async () => {
    const { control } = await fauxControlledAgent([]);
    const plane = createControlPlane(control).handler;
    const auth = { "content-type": "application/json" };
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
    const plane = createControlPlane(control).handler;
    const auth = { "content-type": "application/json" };
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
      const remote = await connectSessionControl({ url: served.url });
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

  it("sessions.list() travels: the deployment's list, isomorphic local and remote", async () => {
    const served = await serveControl();
    try {
      await drain(served.agent.invoke({ session: "sList" }, { text: "hi" }));
      const remote = await connectSessionControl({ url: served.url });
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
      const faulty = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(broken(ioError))] }), {
        port: 0,
      });
      const faultyPort = await faulty.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${faultyPort}/control/sessions`, {});
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code: SESSIONS_UNAVAILABLE_CODE, retryable: true });
        expect(logged.join("\n")).toMatch(/EACCES/); // and the operator sees it, not just the client

        // And the client can READ that code — the whole point of carrying it on the wire.
        const remote = await connectSessionControl({ url: `http://127.0.0.1:${faultyPort}` });
        // `retryable` travels too: a THROWING read has no `SessionResult` to carry it, and the rule is that
        // `retryable` answers whether to re-send — leaving the caller to infer it from the status would make that
        // rule false on the one path that can reject.
        await expect(remote.sessions.list()).rejects.toMatchObject({
          code: SESSIONS_UNAVAILABLE_CODE,
          status: 503,
          retryable: true,
        });
      } finally {
        await faulty.close();
      }

      // A TypeError from our own row building is a BUG: it goes back to the plane's boundary, which
      // logs it and answers 500 — never `retryable: true`, which would have a client poll forever.
      const buggy = serveNode(
        router({
          selfVerifying: {},
          mounts: [createControlPlane(broken(new TypeError("rows.map is not a function")))],
        }),
        {
          port: 0,
        },
      );
      const buggyPort = await buggy.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${buggyPort}/control/sessions`, {});
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
      const misread = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(broken(nodeBug))] }), {
        port: 0,
      });
      const misreadPort = await misread.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${misreadPort}/control/sessions`, {});
        expect(res.status).toBe(500);
      } finally {
        await misread.close();
      }

      // And a thrown null reaches the boundary as ITSELF, not as a TypeError from reading `.code`.
      const nothing = serveNode(router({ selfVerifying: {}, mounts: [createControlPlane(broken(null))] }), { port: 0 });
      const nothingPort = await nothing.listening;
      try {
        const res = await fetch(`http://127.0.0.1:${nothingPort}/control/sessions`, {});
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

// Both SSE routes are one `sseResponse` (channels/sse.ts) over a different source; the routes' own
// halves are covered above ("events stream live over SSE", "the remote data plane"), so the shared
// lifecycle is exercised once, through the invoke route that mounts it.
describe("SSE response lifecycle", () => {
  const respond = (source: AsyncIterable<unknown>): Promise<Response> =>
    createInvokeHandler({ invoke: () => source as AsyncIterable<AgentEvent> })(
      new Request("http://x/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"session":"s","text":"hi"}',
      }),
    );

  it("closes the source and heartbeat when a pull fails", async () => {
    vi.useFakeTimers();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    try {
      const res = await respond({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("source failed");
          },
          return: returned,
        }),
      });
      await expect(res.text()).rejects.toThrow("source failed");
      expect(returned).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("closes the source and heartbeat when serialization fails", async () => {
    vi.useFakeTimers();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    try {
      const res = await respond({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({
            done: false,
            value: {
              toJSON() {
                throw new Error("serialization failed");
              },
            },
          }),
          return: returned,
        }),
      });
      await expect(res.text()).rejects.toThrow("serialization failed");
      expect(returned).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves both an asynchronous source error and a cleanup failure", async () => {
    const sourceError = new Error("source failed");
    const cleanupError = new Error("cleanup failed");
    const res = await respond({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw sourceError;
        },
        return: async () => {
          throw cleanupError;
        },
      }),
    });
    await expect(res.text()).rejects.toMatchObject({ cause: sourceError, errors: [sourceError, cleanupError] });
  });

  it("ignores a pending pull that settles after cancellation", async () => {
    let settle!: (value: IteratorResult<unknown>) => void;
    const pending = new Promise<IteratorResult<unknown>>((resolve) => {
      settle = resolve;
    });
    const toJSON = vi.fn(() => ({ type: "text", delta: "late" }));
    const returned = vi.fn(async () => {
      settle({ done: false, value: { toJSON } });
      return { done: true as const, value: undefined };
    });
    const res = await respond({
      [Symbol.asyncIterator]: () => ({ next: () => pending, return: returned }),
    });
    const reader = res.body!.getReader();
    const read = reader.read();
    await reader.cancel();
    await expect(read).resolves.toMatchObject({ done: true });
    expect(returned).toHaveBeenCalledOnce();
    expect(toJSON).not.toHaveBeenCalled();
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
  // BOTH planes, because `connectAgent` drives the DATA plane (`POST /invoke`) and observes through control.
  const server = serveNode(
    router({ unverified: { "POST /invoke": createInvokeHandler(agent) }, mounts: [createControlPlane(control)] }),
    { port: 0 },
  );
  const port = await server.listening;
  conformanceServers.push(() => server.close());
  return connectAgent({ url: `http://127.0.0.1:${port}` });
}

describeSpecConformance("remote agent over /invoke", {
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
