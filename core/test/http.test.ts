import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createAgent, piHarnessFactory, type AgentEvent } from "../src/index.ts";
import { createInvokeHandler } from "../src/index.ts";

async function startServer(responses: FauxResponseStep[]) {
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  const agent = createAgent({
    buildHarness: piHarnessFactory({
      repo: new InMemorySessionRepo(),
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
  it("POST /invoke → SSE 流出 text + completed", async () => {
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

  it("同 session 并发:一个流式跑完,另一个 SSE 收到 failed 'session busy'", async () => {
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

  it("不同 session 并发:两个都跑完", async () => {
    const srv = await startServer([fauxAssistantMessage("A"), fauxAssistantMessage("B")]);
    try {
      const [ea, eb] = await Promise.all([invoke(srv.url, "a", "x"), invoke(srv.url, "b", "y")]);
      expect(ea.at(-1)?.type).toBe("completed");
      expect(eb.at(-1)?.type).toBe("completed");
    } finally {
      await srv.close();
    }
  });

  it("坏请求 → 400 / 错路径 → 404", async () => {
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
});
