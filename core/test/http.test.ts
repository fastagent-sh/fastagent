import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createInvokeHandler, inMemorySessionStore, type Agent, type AgentEvent } from "../src/index.ts";
import { createPiAgentFromHarness } from "../src/engines/pi/invoke.ts";
import { piHarnessFactory } from "../src/engines/pi/harness.ts";

async function startServer(responses: FauxResponseStep[]) {
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  const agent = createPiAgentFromHarness({
    harnessFactory: piHarnessFactory({
      sessions: inMemorySessionStore(),
      env: new NodeExecutionEnv({ cwd: process.cwd() }),
      model: faux.getModel(),
      systemPrompt: "test",
    }),
  });
  const server = createServer(createInvokeHandler(agent));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** POST /invoke and parse SSE lines into AgentEvent[]. */
async function invoke(url: string, session: string, text: string): Promise<AgentEvent[]> {
  const res = await fetch(`${url}/invoke`, { method: "POST", body: JSON.stringify({ session, text }) });
  const body = await res.text();
  return body
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice("data: ".length)) as AgentEvent);
}

describe("http channel (SSE)", () => {
  it("accepts an agent getter and serves the current (hot-swappable) agent", async () => {
    const fake = (mark: string): Agent => ({
      // eslint-disable-next-line require-yield
      async *invoke() {
        yield { type: "text", delta: mark };
        yield { type: "completed" };
      },
    });
    let agent = fake("A");
    const server = createServer(createInvokeHandler(() => agent));
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      expect((await invoke(url, "s", "x")).find((e) => e.type === "text")).toMatchObject({ delta: "A" });
      agent = fake("B"); // hot-swap behind the getter
      expect((await invoke(url, "s", "x")).find((e) => e.type === "text")).toMatchObject({ delta: "B" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("POST /invoke streams text + completed over SSE", async () => {
    const srv = await startServer([fauxAssistantMessage("hello over http")]);
    try {
      const events = await invoke(srv.url, "s1", "hi");
      const text = events.filter((e) => e.type === "text").map((e) => (e as any).delta).join("");
      expect(text).toBe("hello over http");
      expect(events.at(-1)).toEqual({ type: "completed" });
    } finally {
      await srv.close();
    }
  });

  it("same-session concurrency: one stream completes, the other receives failed 'session busy' over SSE", async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const srv = await startServer([
      async () => {
        started(); // first turn has entered (lease held)
        await gate; // park here, stay in flight
        return fauxAssistantMessage("first");
      },
      fauxAssistantMessage("second"),
    ]);
    try {
      const p1 = invoke(srv.url, "same", "a");
      await ready; // make sure req1 holds the lease
      const e2 = await invoke(srv.url, "same", "b"); // must be busy at this point

      expect(e2).toHaveLength(1);
      expect(e2[0]).toMatchObject({ type: "failed", retryable: true });
      expect((e2[0] as any).details).toMatch(/busy/);

      release();
      const e1 = await p1;
      expect(e1.at(-1)?.type).toBe("completed");
    } finally {
      release(); // avoid leaking the gate
      await srv.close();
    }
  });

  it("different-session concurrency: both complete", async () => {
    const srv = await startServer([fauxAssistantMessage("A"), fauxAssistantMessage("B")]);
    try {
      const [ea, eb] = await Promise.all([invoke(srv.url, "a", "x"), invoke(srv.url, "b", "y")]);
      expect(ea.at(-1)?.type).toBe("completed");
      expect(eb.at(-1)?.type).toBe("completed");
    } finally {
      await srv.close();
    }
  });

  it("bad request returns 400; wrong path returns 404", async () => {
    const srv = await startServer([fauxAssistantMessage("x")]);
    try {
      const bad = await fetch(`${srv.url}/invoke`, { method: "POST", body: "{not json" });
      expect(bad.status).toBe(400);
      const missing = await fetch(`${srv.url}/invoke`, { method: "POST", body: JSON.stringify({ session: "s" }) });
      expect(missing.status).toBe(400);
      const notfound = await fetch(`${srv.url}/other`);
      expect(notfound.status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it("client disconnect cancels invoke (generator cleanup runs, SPEC MUST 3)", async () => {
    let cancelled = false;
    let resolveCancelled!: () => void;
    const cancelledSeen = new Promise<void>((r) => (resolveCancelled = r));
    // Fake agent: slowly streams text; if cancelled before natural completion, finally records evidence
    const fake: Agent = {
      invoke: async function* () {
        let finished = false;
        try {
          for (let i = 0; i < 10_000; i++) {
            yield { type: "text", delta: "x" } as AgentEvent;
            await new Promise((r) => setTimeout(r, 5));
          }
          finished = true;
          yield { type: "completed" } as AgentEvent;
        } finally {
          if (!finished) {
            cancelled = true;
            resolveCancelled();
          }
        }
      },
    };
    const server = createServer(createInvokeHandler(fake));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const controller = new AbortController();
      const res = await fetch(`http://localhost:${port}/invoke`, {
        method: "POST",
        body: JSON.stringify({ session: "s", text: "hi" }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // confirm the stream has started
      controller.abort(); // simulate client disconnect
      // cleanup must happen within a bounded time; timeout means failure
      await Promise.race([
        cancelledSeen,
        new Promise((_, reject) => setTimeout(() => reject(new Error("invoke was never cancelled after client disconnect")), 3000)),
      ]);
      expect(cancelled).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("oversized body returns 413 before invoke and counts real bytes, not JS characters", async () => {
    const srv = await startServer([fauxAssistantMessage("x")]);
    try {
      const big = await fetch(`${srv.url}/invoke`, {
        method: "POST",
        body: JSON.stringify({ session: "s", text: "x".repeat(2 * 1024 * 1024) }),
      });
      expect(big.status).toBe(413);
      // Multibyte input: 400k emoji is 400k characters but over 1 MiB in bytes, so it must be rejected
      const multibyte = await fetch(`${srv.url}/invoke`, {
        method: "POST",
        body: JSON.stringify({ session: "s", text: "🙂".repeat(400_000) }),
      });
      expect(multibyte.status).toBe(413);
    } finally {
      await srv.close();
    }
  });
});
