import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Receipt, ResumeEvent, SessionEvent } from "../src/agent-api.ts";
import { stream, waitForMessage } from "../src/agent-api-stream.ts";
import { connectAgentApi } from "../src/agent-api-remote.ts";
import { createAgentApiHandler } from "../src/channels/agent-api-http.ts";
import { serveNode } from "../src/channels/serve.ts";
import { agentApiConformance, type AgentApiSubject } from "./agent-api-conformance.ts";
import { durableSubject } from "./durable-subject.ts";

function httpSubject(): AgentApiSubject {
  const local = durableSubject();
  let server: ReturnType<typeof serveNode> | undefined;
  const close = async () => {
    server?.closeAllConnections();
    await server?.close();
    server = undefined;
  };
  const open = async (agent: Agent) => {
    server = serveNode(createAgentApiHandler(agent), { port: 0, host: "127.0.0.1" });
    return connectAgentApi({ url: `http://127.0.0.1:${await server.listening}` });
  };
  return {
    async start(options) {
      await close();
      return open(await local.start(options));
    },
    async restart() {
      await close();
      return open(await local.restart());
    },
    release: () => local.release(),
    held: () => local.held(),
    signalled: () => local.signalled(),
    effects: () => local.effects(),
    failStorage: () => local.failStorage(),
    async stop() {
      await close();
      await local.stop();
    },
  };
}

agentApiConformance("pi-durable over HTTP", httpSubject());

async function collected<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

for (const [name, makeSubject] of [
  ["in process", durableSubject],
  ["over HTTP", httpSubject],
] as const) {
  describe(`message helpers ${name}`, () => {
    let subject: AgentApiSubject;
    let agent: Agent;
    let sessionId: string;
    const content = (text: string) => [{ type: "text" as const, text }];
    const send = async (text: string, key: string) => {
      const result = await agent.invoke({ sessionId, content: content(text), idempotencyKey: key });
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    beforeEach(async () => {
      subject = makeSubject();
      agent = await subject.start();
      const session = await agent.createSession();
      if (!session.ok) throw new Error(JSON.stringify(session));
      sessionId = session.sessionId;
    });
    afterEach(() => subject.stop());

    it.each(["new", "queued", "taken", "done"] as const)("streams a %s message through its own done", async (mode) => {
      const word = mode === "taken" ? "hold" : "hi";
      let receipt: Receipt | undefined;
      if (mode === "queued") {
        await send("hold", "blocking");
        await vi.waitFor(() => expect(subject.held()).toBe(1));
      }
      if (mode !== "new") {
        const accepted = await send(word, "message");
        receipt = accepted;
        if (mode === "taken") await vi.waitFor(() => expect(subject.held()).toBe(1));
        if (mode === "done") await accepted.wait();
      }
      const result = await stream(agent, { sessionId, content: content(word), idempotencyKey: "message" });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result.duplicate).toBe(mode !== "new");
      if (receipt) expect(result.message.messageId).toBe(receipt.message.messageId);
      subject.release();
      const events = await collected(result.events);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        message: { messageId: result.message.messageId, outcome: { status: "completed" } },
      });
      expect(events.some((event) => event.type === "entry" && event.entry.kind === "user_message")).toBe(false);
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(events.some((event) => event.type === "entry" && event.entry.kind === "assistant_message")).toBe(true);
      expect(events.some((event) => event.type === "serving_error")).toBe(false);
    });

    it("bounds a taken duplicate that ends and is followed by another message before reattachment", async () => {
      await send("hold", "first");
      await vi.waitFor(() => expect(subject.held()).toBe(1));
      const wrapped: Agent = {
        ...agent,
        async invoke(request) {
          const result = await agent.invoke(request);
          if (!result.ok) return result;
          expect(result.message.status).toBe("taken");
          subject.release();
          await result.wait();
          await (await send("next", "second")).wait();
          return result;
        },
      };
      const result = await stream(wrapped, { sessionId, content: content("hold"), idempotencyKey: "first" });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const events = await collected(result.events);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { messageId: result.message.messageId } });
      expect(events.some((event) => event.type === "entry" && event.entry.kind === "user_message")).toBe(false);
      expect(
        events.some(
          (event) => event.type === "entry" && (event.entry.data as { text?: string }).text === "answer: next",
        ),
      ).toBe(false);
      expect(events.filter((event) => event.type === "entry")).toHaveLength(3);
    });

    it("ignores events before a newly taken message's user entry", async () => {
      const wrapped: Agent = {
        ...agent,
        async invoke(request) {
          await (await send("earlier", "earlier")).wait();
          return agent.invoke(request);
        },
      };
      const result = await stream(wrapped, { sessionId, content: content("hold"), idempotencyKey: "new" });
      if (!result.ok) throw new Error(JSON.stringify(result));
      await vi.waitFor(() => expect(subject.held()).toBe(1));
      subject.release();
      const events = await collected(result.events);
      expect(
        events.some(
          (event) => event.type === "entry" && (event.entry.data as { text?: string }).text === "answer: earlier",
        ),
      ).toBe(false);
      expect(events.filter((event) => event.type === "entry")).toHaveLength(3);
    });

    it("passes an invoke's refusal and unknown through, with known ids", async () => {
      const unknown = { ok: false as const, unknown: { reason: "lost receipt", sessionId, messageId: "known" } };
      expect(await stream({ ...agent, invoke: async () => unknown }, { sessionId, content: content("hi") })).toEqual(
        unknown,
      );
      await send("hold", "block");
      await vi.waitFor(() => expect(subject.held()).toBe(1));
      expect(await stream(agent, { sessionId, content: content("hi"), whenBusy: "reject" })).toMatchObject({
        ok: false,
        error: { code: "busy" },
      });
      subject.release();
    });

    it.each([false, true])(
      "detaches without stopping the message, including before consuming events (pending=%s)",
      async (pending) => {
        const watches: AsyncIterator<ResumeEvent>[] = [];
        let detached = 0;
        const wrapped: Agent = {
          ...agent,
          resume(id, options) {
            const source = agent.resume(id, options)[Symbol.asyncIterator]();
            watches.push(source);
            return {
              [Symbol.asyncIterator]: () => ({
                next: () => source.next(),
                async return() {
                  detached++;
                  return (await source.return?.()) ?? { done: true, value: undefined };
                },
              }),
            };
          },
        };
        const result = await stream(wrapped, { sessionId, content: content("hold"), idempotencyKey: "hold" });
        if (!result.ok) throw new Error(JSON.stringify(result));
        const iterator = result.events[Symbol.asyncIterator]();
        let read: Promise<IteratorResult<SessionEvent>> | undefined;
        if (pending) {
          for (let item = await iterator.next(); !item.done; item = await iterator.next()) {
            if (item.value.type === "tool_started") break;
          }
          await vi.waitFor(() => expect(subject.held()).toBe(1));
          read = iterator.next();
        }
        await iterator.return?.();
        if (read) expect((await read).done).toBe(true);
        expect(detached).toBe(watches.length);
        expect((await agent.getMessage(sessionId, { messageId: result.message.messageId }))?.status).not.toBe("done");
        await vi.waitFor(() => expect(subject.held()).toBe(1));
        subject.release();
        expect(await waitForMessage(agent, result)).toMatchObject({
          ok: true,
          message: { outcome: { status: "completed" } },
        });
      },
    );
  });
}

describe("Agent API HTTP boundary", () => {
  const subject = durableSubject();
  let server: ReturnType<typeof serveNode> | undefined;
  const remote = async (agent: Agent, fetchFn: typeof fetch = fetch) => {
    server = serveNode(createAgentApiHandler(agent), { port: 0, host: "127.0.0.1" });
    return {
      url: `http://127.0.0.1:${await server.listening}`,
      connect: (url: string) => connectAgentApi({ url, fetchFn }),
    };
  };
  afterEach(async () => {
    server?.closeAllConnections();
    await server?.close();
    server = undefined;
    await subject.stop();
  });

  it("uses 202 for receipt data, and 503 unknown preserves every known id through the client", async () => {
    const agent = await subject.start();
    const handler = createAgentApiHandler(agent);
    const response = await handler(
      new Request("http://local/invoke", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    const receipt = (await response.json()) as Receipt;
    expect(receipt).toMatchObject({
      sessionId: expect.any(String),
      message: { messageId: expect.any(String) },
      duplicate: false,
    });
    expect(receipt).not.toHaveProperty("ok");
    expect(receipt).not.toHaveProperty("wait");

    const unknown = {
      ok: false as const,
      unknown: { reason: "status read failed", sessionId: receipt.sessionId, messageId: receipt.message.messageId },
    };
    const { url, connect } = await remote({ ...agent, invoke: async () => unknown });
    const client = await connect(url);
    expect(await client.invoke({ content: [{ type: "text", text: "hi" }] })).toEqual(unknown);
  });

  it("reports unknown on a connection lost after acceptance, and the same key finds the recorded message", async () => {
    const agent = await subject.start();
    const created = await agent.createSession();
    if (!created.ok) throw new Error(JSON.stringify(created));
    let cut = true;
    const { url, connect } = await remote(agent, async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/invoke") && cut) {
        cut = false;
        await response.arrayBuffer();
        throw new Error("the connection was lost before the receipt arrived");
      }
      return response;
    });
    const client = await connect(url);
    const request = {
      sessionId: created.sessionId,
      idempotencyKey: "once",
      content: [{ type: "text" as const, text: "effect" }],
    };
    expect(await client.invoke(request)).toMatchObject({ ok: false, unknown: { sessionId: created.sessionId } });
    const retry = await client.invoke(request);
    if (!retry.ok) throw new Error(JSON.stringify(retry));
    expect(retry.duplicate).toBe(true);
    await retry.wait();
    expect(subject.effects()).toBe(1);
  });

  it("rejects malformed and excess request fields without invoking", async () => {
    const agent = await subject.start();
    const invoke = vi.spyOn(agent, "invoke");
    const handler = createAgentApiHandler(agent);
    for (const body of [
      "{",
      JSON.stringify({ prompt: { text: "old" } }),
      JSON.stringify({ content: [{ type: "text", text: "hi" }], source: { kind: "channel" } }),
      "x".repeat((1 << 20) + 1),
    ]) {
      const response = await handler(
        new Request("http://local/invoke", { method: "POST", headers: { "content-type": "application/json" }, body }),
      );
      expect(response.status).toBe(400);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("gives snapshot cursors before any live entry, and Last-Event-ID overrides URL cursors", async () => {
    const agent = await subject.start();
    const session = await agent.createSession();
    if (!session.ok) throw new Error(JSON.stringify(session));
    const handler = createAgentApiHandler(agent);
    const snapshot = async (suffix = "", header?: string) => {
      const response = await handler(
        new Request(`http://local/sessions/${session.sessionId}/events${suffix}`, {
          headers: header === undefined ? {} : { "Last-Event-ID": header },
        }),
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no SSE body");
      const decoder = new TextDecoder();
      const frames: { id?: string; event: ResumeEvent }[] = [];
      let buffer = "";
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) throw new Error("no snapshot");
          buffer += decoder.decode(next.value, { stream: true });
          for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            if (!data) continue;
            const event = JSON.parse(data.slice(6)) as ResumeEvent;
            frames.push({
              id: frame
                .split("\n")
                .find((line) => line.startsWith("id: "))
                ?.slice(4),
              event,
            });
            if (event.type === "state") return frames;
          }
        }
      } finally {
        await reader.cancel();
      }
    };
    const empty = await snapshot();
    expect(empty).toMatchObject([{ id: "start", event: { type: "state" } }]);
    const send = async (word: string) => {
      const result = await agent.invoke({ sessionId: session.sessionId, content: [{ type: "text", text: word }] });
      if (!result.ok) throw new Error(JSON.stringify(result));
      await result.wait();
    };
    await send("one");
    const all = await snapshot("?after=invalid&replay=start", "start");
    expect(all.filter(({ event }) => event.type === "entry")).toHaveLength(2);
    const cursor = all.at(-1)?.id as string;
    const none = await snapshot();
    expect(none).toMatchObject([{ id: cursor, event: { type: "state" } }]);
    await send("two");
    const later = await snapshot("?after=invalid&replay=start", cursor);
    expect(later.filter(({ event }) => event.type === "entry")).toHaveLength(2);
    expect(later.at(-1)?.id).not.toBe(cursor);
  });

  it("passes session creation settings over HTTP without adding per-invoke model fields", async () => {
    const agent = await subject.start();
    const create = vi.spyOn(agent, "createSession");
    const { url, connect } = await remote(agent);
    const client = await connect(url);
    const options = { model: { provider: "subject", modelId: "faux-1" }, thinkingLevel: "off" as const };
    expect(await client.createSession(options)).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledWith(options);
    const response = await fetch(`${url}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: [{ type: "text", text: "hi" }], model: options.model }),
    });
    expect(response.status).toBe(400);
  });

  it("preserves unknown events and diagnoses malformed known events instead of silently parsing them", async () => {
    const agent = await subject.start();
    const session = await agent.createSession();
    if (!session.ok) throw new Error(JSON.stringify(session));
    let malformed = false;
    const forwarded = { type: "fastagent.notice", detail: { text: "an extension's event" } };
    const wrapped: Agent = {
      ...agent,
      resume(id, options) {
        return {
          async *[Symbol.asyncIterator]() {
            const source = agent.resume(id, options)[Symbol.asyncIterator]();
            try {
              const first = await source.next();
              if (!first.done) yield first.value;
              yield (malformed
                ? { type: "tool_started", toolCallId: "missing fields" }
                : forwarded) as unknown as ResumeEvent;
              yield {
                type: "serving_error" as const,
                error: { code: "unavailable", message: "stopped", retryable: true },
              };
            } finally {
              await source.return?.();
            }
          },
        };
      },
    };
    const { url, connect } = await remote(wrapped);
    const client = await connect(url);
    expect(await collected(client.resume(session.sessionId))).toContainEqual(forwarded);
    malformed = true;
    const broken = await collected(client.resume(session.sessionId));
    expect(broken.map((event) => event.type)).toEqual(["state", "serving_error"]);
    const refused = await collected(client.resume("unknown"));
    expect(JSON.parse(JSON.stringify(refused))).toEqual(refused);
  });

  it("serializes a rejected read's error message and code over HTTP", async () => {
    const agent = await subject.start();
    const session = await agent.createSession();
    if (!session.ok) throw new Error(JSON.stringify(session));
    const { url, connect } = await remote(agent);
    const client = await connect(url);
    subject.failStorage();
    await expect(client.getMessage(session.sessionId, { messageId: "unknown" })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("the disk is gone"),
    });
  });

  it("ends a severed observation with serving_error, not a silent end or a stopped message", async () => {
    const agent = await subject.start();
    const session = await agent.createSession();
    if (!session.ok) throw new Error(JSON.stringify(session));
    const { url, connect } = await remote(agent);
    const client = await connect(url);
    const receipt = await client.invoke({ sessionId: session.sessionId, content: [{ type: "text", text: "hold" }] });
    if (!receipt.ok) throw new Error(JSON.stringify(receipt));
    await vi.waitFor(() => expect(subject.held()).toBe(1));
    const watching = client.resume(session.sessionId)[Symbol.asyncIterator]();
    expect((await watching.next()).value).toMatchObject({ type: "state" });
    const pending = watching.next();
    server?.closeAllConnections();
    expect((await pending).value).toMatchObject({ type: "serving_error", error: { code: "unavailable" } });
    expect((await watching.next()).done).toBe(true);
    expect((await agent.getMessage(session.sessionId, { messageId: receipt.message.messageId }))?.status).toBe("taken");
    subject.release();
    expect(await waitForMessage(agent, receipt)).toMatchObject({ ok: true });
  });

  it("refuses non-JSON POSTs, including body-less abort, before calling the Agent", async () => {
    const agent = await subject.start();
    const create = await agent.createSession();
    if (!create.ok) throw new Error(JSON.stringify(create));
    const handler = createAgentApiHandler(agent);
    for (const path of ["/invoke", "/sessions", `/sessions/${create.sessionId}/abort`]) {
      for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
        const response = await handler(
          new Request(`http://local${path}`, {
            method: "POST",
            ...(type === undefined ? {} : { headers: { "content-type": type } }),
          }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      }
    }
    expect(await agent.read(create.sessionId)).toMatchObject({ entries: [], state: { status: "idle" } });
  });
});
