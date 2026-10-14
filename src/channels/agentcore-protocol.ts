/** The wire between the forwarder Lambda and the container, in ONE place. */
import { secretEquals } from "./secret.ts";

/** Paths the forwarder answers ITSELF — never forwarded to a channel route. */
export const RESERVED_PATHS = {
  /** The deploy driver's post-deploy verification (ingress secret). */
  probe: "/__fastagent/probe",
  /** The container's wake-alarm mirror callback (wake secret). */
  wakeAlarm: "/__fastagent/wake-alarm",
} as const;

/** Every kind the container's `POST /invocations` dispatches on. */
export const ENVELOPE_KINDS = ["webhook", "schedule-fire", "api", "wake-poke", "probe"] as const;

/**
 * Did this envelope come from the FORWARDER, rather than from some other principal holding
 * `bedrock-agentcore:InvokeAgentRuntime`?
 *
 * WHAT IT ACTUALLY GUARDS, in one line: only the forwarder may tell the container where the forwarder is. That URL
 * (`envelope.wake.url`) is where the container later POSTs its wake alarms, carrying `FASTAGENT_WAKE_SECRET` — so a
 * principal who could set it would redirect that callback and collect the secret along with every pending wake-up.
 *
 * The other thing it gates — the kinds other than `api` — is DEPTH, not a boundary. Every one of them is weaker than
 * the `api` the same caller may already send: `schedule-fire` runs a prompt the definition wrote down,
 * `webhook` reaches only channel routes that verify their own platform's signature, `wake-poke` wakes, `probe`
 * reports. IAM is what decides who gets to ask at all.
 *
 * ONE reading, because the deferred wrapper answers a probe before the adapter exists and would otherwise spell the
 * same rule twice (channels/agentcore-service.ts).
 */
export function fromForwarder(envelope: { auth?: unknown } | undefined, expected: string | undefined): boolean {
  return secretEquals(envelope?.auth, expected);
}

/** An HTTP request carried inside an envelope, byte-exact. */
export interface CarriedRequest {
  method: string;
  path: string;
  /** Raw query string, no leading `?`. */
  query?: string;
  headers?: Record<string, string>;
  /** The body, base64 (byte-exact). */
  bodyB64?: string;
}

/** What the forwarder Lambda / EventBridge deliver in the `/invocations` payload. */
export type AgentcoreEnvelope = {
  /** Shared secret proving this envelope came from the forwarder (FASTAGENT_INGRESS_SECRET). */
  auth?: string;
  wake?: { url: string };
} /** A platform's webhook, verbatim: its headers carry the signature material its channel checks. */ & (
  | ({ kind: "webhook" } & CarriedRequest)
  | {
      kind: "schedule-fire";
      name: string;
      /**
       * The instant EventBridge scheduled this fire for — the clock's NAME for the occurrence, stable across its
       * redeliveries (measured: 3 attempts of one fire, byte-identical payload). The container dedupes on it and
       * never recomputes it.
       */
      occurrence: string;
    }
  /**
   * A request to the agent's own API (SPEC v1 §9, both planes), from an IAM principal: IAM is this host's gateway
   * (agent-service.md §7.7). The forwarder never emits it.
   */
  | ({ kind: "api" } & CarriedRequest)
  /**
   * An EventBridge wake-up poke: the invocation ITSELF is the payload — it wakes the container, whose boot drain / 30s
   * wake pump then fires whatever is due.
   */
  | { kind: "wake-poke" }
  /**
   * The deploy driver's post-deploy verification (relayed by the forwarder's reserved probe path, which answers on
   * EVERY forwarder topology — schedule-only URLs refuse ordinary public traffic). Also accepted from the IAM door,
   * where it only opens the deployed definition (`login --deployment` needs one) and does not construct the channels.
   */
  | { kind: "probe" }
);

/**
 * The webhook envelope's reply: the channel's real HTTP response, ridden inside a transport-200 body so the forwarder
 * can re-emit it verbatim (AgentCore folds a container non-2xx into its own 424 RuntimeClientError).
 */
export interface WebhookReply {
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}

/** One desired one-shot alarm: a pending wake-up's next instant, which pokes the container. */
export interface WakeAlarm {
  /** One per INSTANT (`<wake id>@<instant>`), so mirroring again never rewrites a spent alarm. */
  id: string;
  at: string;
}

/**
 * One desired RECURRING schedule: a `schedules/` file as an EventBridge cron schedule, which EventBridge fires on its
 * own clock. Each fire delivers `{scheduleFire: {name, occurrence: <aws.scheduler.scheduled-time>}}`, the instant it
 * was scheduled for, repeated byte-identical on every redelivery, which is what lets the container claim it once.
 */
export interface RecurringSchedule {
  name: string;
  /** EventBridge's `cron(...)` (schedule/eventbridge-cron.ts). */
  expression: string;
  /** IANA zone the expression is evaluated in. */
  tz: string;
}

/**
 * The wire shape the wake sink POSTs to {@link RESERVED_PATHS.wakeAlarm} (the forwarder validates `secret`). The
 * schedules are the WHOLE desired set: the forwarder deletes a recurring schedule it holds that is not in it.
 */
export interface WakeAlarmRequest {
  secret: string;
  alarms: WakeAlarm[];
  schedules: RecurringSchedule[];
}
