import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { otlpTraces } from "../../../packages/fastagent/src/harnesses/telemetry/otlp.ts";
import { type FinishedSpan, recordingTelemetry } from "../../../packages/fastagent/src/harnesses/telemetry/spans.ts";
import { log } from "../../../packages/fastagent/src/log.ts";
import { fauxAgent } from "../../doubles/cli-run.ts";
import { openSource } from "../../harnesses/open-source.ts";

const carrier = (traceId: string, spanId: string) => ({ traceparent: `00-${traceId}-${spanId}-01` });

/** pi's contract for a telemetry adapter, held against the one the instance records its runs with. */
const conformance = createTelemetryAdapterConformance(async () => {
  const finished: FinishedSpan[] = [];
  const context = recordingTelemetry((span) => finished.push(span));
  return {
    context,
    ...(context.propagation === undefined ? {} : { propagation: context.propagation }),
    getSpans: async () => {
      const ids = new Map(finished.map((span, index) => [span.spanId, index + 1]));
      return finished.map((span, index) => ({
        id: index + 1,
        parentId: span.parentSpanId === undefined ? null : (ids.get(span.parentSpanId) ?? null),
        context: carrier(span.traceId, span.spanId),
        parentContext: span.parentSpanId === undefined ? null : carrier(span.traceId, span.parentSpanId),
        links: span.links.map((link) => ({ context: carrier(link.traceId, link.spanId), attributes: link.attributes })),
        name: span.name,
        attributes: span.attributes,
        events: span.events.map(({ name, attributes }) => ({ name, attributes })),
        status: span.status,
        settled: true,
        endSequence: index + 1,
      }));
    },
    async [Symbol.asyncDispose]() {},
  };
});

describe("the runs' spans, recorded as pi's telemetry contract asks", () => {
  for (const group of new Set(conformance.map((testCase) => testCase.group))) {
    describe(group, () => {
      for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
        it(testCase.name, () => testCase.run());
      }
    });
  }
});

/** A collector on loopback: what it was sent, and with which headers. `held` keeps it from answering until released. */
async function collector({ held = false } = {}) {
  const received: { path?: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  const waiting: (() => void)[] = [];
  let answering = !held;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      const answer = () => res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (answering) answer();
      else waiting.push(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const release = () => {
    answering = true;
    for (const answer of waiting.splice(0)) answer();
  };
  return {
    url,
    received,
    release,
    close: () => {
      release();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

type OtlpSpan = { name: string; traceId: string; parentSpanId?: string; attributes: { key: string; value: any }[] };
const spansOf = (body: any): OtlpSpan[] =>
  body.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans));
const attribute = (span: OtlpSpan, key: string) => span.attributes.find((a) => a.key === key)?.value;

describe("run traces over OTLP", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends each run's spans, a model request's tokens under the GenAI names, to the collector the environment names", async () => {
    const otlp = await collector();
    try {
      const dir = await fauxAgent("fa-traces-");
      const agent = await openSource(dir, {
        secrets: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20t",
        },
      });
      const { id } = await agent.sessions.create();
      expect((await agent.messages.send({ sessionId: id, content: "hello" }, { wait: 30 })).status).toBe("completed");
      await agent.close();

      expect(otlp.received.length).toBeGreaterThan(0);
      expect(otlp.received[0]?.headers.authorization).toBe("Bearer t");
      const resource = otlp.received[0]?.body.resourceSpans[0].resource.attributes;
      expect(resource).toEqual(
        expect.arrayContaining([{ key: "service.name", value: { stringValue: expect.any(String) } }]),
      );
      const spans = otlp.received.flatMap(({ body }) => spansOf(body));
      expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(["pi.durable.submit", "pi.ai.request"]));
      const request = spans.find((span) => span.name === "pi.ai.request") as OtlpSpan;
      expect(attribute(request, "gen_ai.provider.name")).toEqual({ stringValue: "gw" });
      expect(attribute(request, "gen_ai.request.model")).toEqual({ stringValue: "m1" });
      expect(attribute(request, "gen_ai.usage.output_tokens")).toEqual({ intValue: expect.any(String) });
      // One trace: the model request is a step of the run its message started.
      expect(spans.find((span) => span.traceId === request.traceId && span.parentSpanId === undefined)).toBeDefined();
    } finally {
      await otlp.close();
    }
  });

  it("answers as ever when the collector is down, saying in the log what it dropped", async () => {
    const otlp = await collector();
    await otlp.close();
    const warned: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((line) => warned.push(line));
    const dir = await fauxAgent("fa-traces-down-");
    const agent = await openSource(dir, { secrets: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url } });
    const { id } = await agent.sessions.create();
    expect((await agent.messages.send({ sessionId: id, content: "hello" }, { wait: 30 })).status).toBe("completed");
    await agent.close();
    expect(warned.some((line) => line.includes("traces:") && line.includes("dropped"))).toBe(true);
  });

  it("drops the batches past its limit while the collector hangs, instead of holding a backlog", async () => {
    const otlp = await collector({ held: true });
    const warned: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((line) => warned.push(line));
    try {
      const traces = otlpTraces({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url }, { serviceName: "a", serviceVersion: "1" });
      if (traces === undefined) throw new Error("expected an exporter");
      for (let i = 0; i < 10_000; i++) await traces.context.startSpan({ name: "step" }, () => undefined);
      otlp.release();
      await traces.close();
      const sent = otlp.received.reduce((count, { body }) => count + spansOf(body).length, 0);
      expect(sent).toBeLessThanOrEqual(4_096 + 512);
      expect(warned.some((line) => line.includes("dropped while the collector was behind"))).toBe(true);
    } finally {
      await otlp.close();
    }
  });

  it("sends what was recorded when the harness closes on its own", async () => {
    // Only the close may send: the batch interval never fires.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const otlp = await collector();
    try {
      const dir = await fauxAgent("fa-traces-harness-");
      const agent = await openSource(dir, { secrets: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url } });
      const { id } = await agent.sessions.create();
      expect((await agent.messages.send({ sessionId: id, content: "hello" }, { wait: 30 })).status).toBe("completed");
      await agent.harness.close(BACKGROUND_CONTEXT);
      for (let tries = 0; otlp.received.length === 0 && tries < 100; tries++) await sleep(20);
      expect(otlp.received.length).toBeGreaterThan(0);
      await agent.close();
    } finally {
      vi.useRealTimers();
      await otlp.close();
    }
  });

  it("reads service.name and the traces path the way the OpenTelemetry variables write them", async () => {
    const otlp = await collector();
    try {
      const nameSent = async (env: Record<string, string>) => {
        otlp.received.length = 0;
        const traces = otlpTraces(
          { OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url, ...env },
          { serviceName: "instance", serviceVersion: "1" },
        );
        await traces?.context.startSpan({ name: "step" }, () => undefined);
        await traces?.close();
        return otlp.received[0]?.body.resourceSpans[0].resource.attributes.find(
          (a: { key: string }) => a.key === "service.name",
        )?.value.stringValue;
      };
      expect(await nameSent({})).toBe("instance");
      await nameSent({ OTEL_EXPORTER_OTLP_ENDPOINT: `${otlp.url}//` });
      expect(otlp.received[0]?.path).toBe("/v1/traces");
      expect(await nameSent({ OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attributes" })).toBe("from-attributes");
      expect(
        await nameSent({ OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attributes", OTEL_SERVICE_NAME: "named" }),
      ).toBe("named");
    } finally {
      await otlp.close();
    }
  });

  it("refuses a header value that is not percent-encoded, naming the variable", () => {
    expect(() =>
      otlpTraces(
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%2" },
        { serviceName: "a", serviceVersion: "1" },
      ),
    ).toThrow('OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%2" is not percent-encoded');
  });

  it("refuses to open on a protocol it cannot send, naming the variable", async () => {
    const dir = await fauxAgent("fa-traces-grpc-");
    await expect(
      openSource(dir, {
        secrets: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4317",
          OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
        },
      }),
    ).rejects.toThrow('OTEL_EXPORTER_OTLP_PROTOCOL is "grpc": FastAgent exports traces as http/json only');
  });
});
