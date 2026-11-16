/**
 * pi's telemetry contract (`TelemetryContext`), recorded: every span pi-durable and pi-ai open, handed to `sink` once it
 * settles, with W3C trace context (`traceparent`) as the carrier, so a task resumed by a later process continues the
 * trace it began in. A span ends when its callback settles; one started from a settled span is not recorded, as pi's
 * reference adapter does.
 */
import { randomBytes } from "node:crypto";
import type {
  AttributeValue,
  SpanAttributes,
  SpanLink,
  SpanStatus,
  TelemetryCarrier,
  TelemetryContext,
  TelemetryPropagation,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { telemetryNow } from "@earendil-works/pi-telemetry";

/** A settled span. Times are wall-clock milliseconds at microsecond resolution. */
export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  attributes: SpanAttributes;
  events: { name: string; timeMs: number; attributes: SpanAttributes }[];
  links: { traceId: string; spanId: string; attributes: SpanAttributes }[];
  status: SpanStatus;
}

interface Identity {
  traceId: string;
  spanId: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** The identity of each context this adapter made, by the object pi holds. */
const identities = new WeakMap<object, Identity>();

const copyAttributes = (attributes: SpanAttributes | undefined): SpanAttributes => {
  const copy: SpanAttributes = {};
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value !== undefined) copy[name] = (Array.isArray(value) ? [...value] : value) as AttributeValue;
  }
  return copy;
};

export function recordingTelemetry(sink: (span: FinishedSpan) => void): TelemetryContext {
  const propagation: TelemetryPropagation = {
    inject(context) {
      const identity = identities.get(context);
      return identity === undefined ? undefined : { traceparent: `00-${identity.traceId}-${identity.spanId}-01` };
    },
    extract(carrier: TelemetryCarrier | undefined) {
      const match = TRACEPARENT.exec(carrier?.traceparent ?? "");
      if (match === null) return root;
      const parent: Identity = { traceId: match[1] as string, spanId: match[2] as string };
      const context: TelemetryContext = {
        propagation,
        startSpan: (options, callback) => startSpan(parent, false, options, callback),
      };
      identities.set(context, parent);
      return context;
    },
  };

  async function startSpan<T>(
    parent: Identity | undefined,
    inert: boolean,
    options: { name: string; attributes?: SpanAttributes; links?: readonly SpanLink[] },
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const identity: Identity = {
      traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
    };
    const recorded: FinishedSpan = {
      ...identity,
      ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
      name: options.name,
      startMs: telemetryNow(),
      endMs: 0,
      attributes: copyAttributes(options.attributes),
      events: [],
      links: [],
      status: { status: "ok" },
    };
    let settled = inert;
    let explicitStatus = false;
    const link = (added: SpanLink) => {
      const target = identities.get(added.context);
      if (target !== undefined) recorded.links.push({ ...target, attributes: copyAttributes(added.attributes) });
    };
    for (const added of options.links ?? []) link(added);
    const span: TelemetrySpan = {
      propagation,
      startSpan: (childOptions, childCallback) => startSpan(identity, settled, childOptions, childCallback),
      addLink(added) {
        if (!settled) link(added);
      },
      addEvent(name, attributes) {
        if (!settled) recorded.events.push({ name, timeMs: telemetryNow(), attributes: copyAttributes(attributes) });
      },
      setAttributes(attributes) {
        if (!settled) recorded.attributes = { ...recorded.attributes, ...copyAttributes(attributes) };
      },
      setStatus(status) {
        if (settled) return;
        recorded.status =
          status.status === "ok"
            ? { status: "ok" }
            : { status: "error", ...(status.error ? { error: { ...status.error } } : {}) };
        explicitStatus = true;
      },
    };
    identities.set(span, identity);
    try {
      return await callback(span);
    } catch (error) {
      if (!explicitStatus) {
        recorded.status =
          error instanceof Error
            ? { status: "error", error: { name: error.name, message: error.message } }
            : { status: "error" };
      }
      throw error;
    } finally {
      if (!settled) {
        settled = true;
        recorded.endMs = telemetryNow();
        sink(recorded);
      }
    }
  }

  const root: TelemetryContext = {
    propagation,
    startSpan: (options, callback) => startSpan(undefined, false, options, callback),
  };
  return root;
}
