/**
 * The instance's run traces, exported over OTLP/HTTP as JSON to the collector the standard OpenTelemetry variables
 * name, shared across both `pi-durable` and `dsh` harnesses: every message's admission, each step of its run with
 * the tools it called, and each model request with its tokens and cost. Spans carry no content (no prompt, no answer,
 * no tool argument). A model request also carries the OpenTelemetry GenAI names (`gen_ai.*`), so a backend that reads
 * those shows its tokens.
 *
 * Off unless `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Spans go out in batches;
 * one the collector refuses, or cannot be reached for, is dropped with a warning, never retried into a backlog, so a
 * collector that is down costs the agent nothing but its traces.
 */
import type { SpanAttributes, TelemetryContext } from "@earendil-works/pi-telemetry";
import { log } from "../../log.ts";
import { type FinishedSpan, recordingTelemetry } from "./spans.ts";

const BATCH_SPANS = 512;
const BATCH_INTERVAL_MS = 5_000;
/** Spans waiting for the collector at most: a batch past it is dropped, so a collector that hangs holds no backlog. */
const MAX_HELD_SPANS = 4_096;
const EXPORT_TIMEOUT_MS = 10_000;

export interface Traces {
  context: TelemetryContext;
  /** Send what is held, then stop. */
  close(): Promise<void>;
}

export interface TraceResource {
  /** `service.name`, unless `OTEL_SERVICE_NAME` names one. */
  serviceName: string;
  serviceVersion: string;
}

/** The traces exporter the environment asks for, or none. A setting it cannot honor refuses the open, naming it. */
export function otlpTraces(
  env: Readonly<Record<string, string | undefined>>,
  resource: TraceResource,
): Traces | undefined {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return undefined;
  const endpoint = tracesEndpoint(env);
  if (endpoint === undefined) return undefined;
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL)?.trim();
  if (protocol !== undefined && protocol !== "" && protocol !== "http/json") {
    throw new Error(`OTEL_EXPORTER_OTLP_PROTOCOL is "${protocol}": FastAgent exports traces as http/json only`);
  }
  const headers = {
    ...parsePairs(env.OTEL_EXPORTER_OTLP_HEADERS, "OTEL_EXPORTER_OTLP_HEADERS"),
    ...parsePairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS, "OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
    "content-type": "application/json",
  };
  const serviceName = env.OTEL_SERVICE_NAME?.trim();
  const resourceAttributes: SpanAttributes = {
    "service.name": resource.serviceName,
    ...parsePairs(env.OTEL_RESOURCE_ATTRIBUTES, "OTEL_RESOURCE_ATTRIBUTES"),
    ...(serviceName ? { "service.name": serviceName } : {}),
    "service.version": resource.serviceVersion,
  };

  let held: FinishedSpan[] = [];
  /** Spans in batches waiting for the collector. */
  let queued = 0;
  let dropped = 0;
  let sending = Promise.resolve();
  const send = (spans: FinishedSpan[]): Promise<void> =>
    fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(exportRequest(spans, resourceAttributes)),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    }).then(
      async (response) => {
        if (!response.ok) {
          const said = (await response.text().catch(() => "")).slice(0, 200);
          log.warn(`[fastagent] traces: ${endpoint} refused ${spans.length} span(s) (HTTP ${response.status}) ${said}`);
        }
      },
      (error: unknown) =>
        log.warn(`[fastagent] traces: ${endpoint} unreachable, ${spans.length} span(s) dropped: ${String(error)}`),
    );
  const flush = (): Promise<void> => {
    if (dropped > 0) {
      log.warn(`[fastagent] traces: ${dropped} span(s) dropped while the collector was behind`);
      dropped = 0;
    }
    const batch = held;
    held = [];
    if (batch.length === 0) return sending;
    if (queued + batch.length > MAX_HELD_SPANS) {
      dropped += batch.length;
      return sending;
    }
    queued += batch.length;
    sending = sending
      .then(() => send(batch))
      .finally(() => {
        queued -= batch.length;
      });
    return sending;
  };
  const timer = setInterval(() => void flush(), BATCH_INTERVAL_MS);
  timer.unref();
  const context = recordingTelemetry((span) => {
    held.push(span);
    if (held.length >= BATCH_SPANS) void flush();
  });
  return {
    context,
    close: async () => {
      clearInterval(timer);
      await flush();
    },
  };
}

function tracesEndpoint(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const own = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (own) return own;
  let base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  while (base?.endsWith("/")) base = base.slice(0, -1);
  return base ? `${base}/v1/traces` : undefined;
}

/** `key=value,key=value`, values percent-decoded, as the OpenTelemetry variables write them. */
function parsePairs(text: string | undefined, variable: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const item of (text ?? "").split(",")) {
    if (item.trim() === "") continue;
    const at = item.indexOf("=");
    if (at <= 0) throw new Error(`${variable}: "${item.trim()}" is not key=value`);
    try {
      pairs[item.slice(0, at).trim()] = decodeURIComponent(item.slice(at + 1).trim());
    } catch {
      throw new Error(`${variable}: "${item.trim()}" is not percent-encoded`);
    }
  }
  return pairs;
}

/** The OpenTelemetry GenAI names for what pi records of a model request; pi's own names stay beside them. */
function withGenAi(span: FinishedSpan): SpanAttributes {
  if (span.name !== "pi.ai.request") return span.attributes;
  const a = span.attributes;
  const number = (name: string) => (typeof a[name] === "number" ? (a[name] as number) : undefined);
  const [input, cacheRead, cacheWrite, output] = [
    "usage.input",
    "usage.cache_read",
    "usage.cache_write",
    "usage.output",
  ].map(number);
  const genAi: SpanAttributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": a.provider,
    "gen_ai.request.model": a.model,
    "gen_ai.response.id": a["response.id"],
    "gen_ai.response.finish_reasons": typeof a.stop === "string" ? [a.stop] : undefined,
    "gen_ai.usage.input_tokens": input === undefined ? undefined : input + (cacheRead ?? 0) + (cacheWrite ?? 0),
    "gen_ai.usage.cache_read.input_tokens": cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": cacheWrite,
    "gen_ai.usage.output_tokens": output,
  };
  return { ...a, ...genAi };
}

const nanos = (ms: number): string => (BigInt(Math.round(ms * 1_000)) * 1_000n).toString();

function anyValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return { stringValue: String(value) };
}

const keyValues = (attributes: SpanAttributes) =>
  Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));

/** OTLP's `ExportTraceServiceRequest`, as JSON. */
function exportRequest(spans: readonly FinishedSpan[], resource: SpanAttributes) {
  return {
    resourceSpans: [
      {
        resource: { attributes: keyValues(resource) },
        scopeSpans: [
          {
            scope: { name: "fastagent" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
              name: span.name,
              kind: 1,
              startTimeUnixNano: nanos(span.startMs),
              endTimeUnixNano: nanos(span.endMs),
              attributes: keyValues(withGenAi(span)),
              events: span.events.map((event) => ({
                name: event.name,
                timeUnixNano: nanos(event.timeMs),
                attributes: keyValues(event.attributes),
              })),
              links: span.links.map((link) => ({
                traceId: link.traceId,
                spanId: link.spanId,
                attributes: keyValues(link.attributes),
              })),
              status:
                span.status.status === "ok"
                  ? { code: 1 }
                  : {
                      code: 2,
                      ...(span.status.error
                        ? { message: `${span.status.error.name}: ${span.status.error.message}` }
                        : {}),
                    },
            })),
          },
        ],
      },
    ],
  };
}
