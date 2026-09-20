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
export const ENVELOPE_KINDS = ["webhook", "routine-fire", "invoke", "wake-poke", "probe"] as const;

/**
 * Did this envelope come from the FORWARDER, rather than from some other principal holding
 * `bedrock-agentcore:InvokeAgentRuntime`?
 *
 * WHAT IT ACTUALLY GUARDS, in one line: only the forwarder may tell the container where the forwarder is. That URL
 * (`envelope.wake.url`) is where the container later POSTs its wake alarms, carrying `FASTAGENT_WAKE_SECRET` — so a
 * principal who could set it would redirect that callback and collect the secret along with every pending wake-up.
 *
 * The other thing it gates — the non-`invoke` kinds — is DEPTH, not a boundary. Every one of them is weaker than
 * the `invoke` the same caller may already send: `routine-fire` runs a prompt the definition wrote down,
 * `webhook` reaches only channel routes that verify their own platform's signature, `wake-poke` wakes, `probe`
 * reports. IAM is what decides who gets to ask at all.
 *
 * ONE reading, because the deferred wrapper answers a probe before the adapter exists and would otherwise spell the
 * same rule twice (channels/agentcore-service.ts).
 */
export function fromForwarder(envelope: { auth?: unknown } | undefined, expected: string | undefined): boolean {
  return secretEquals(envelope?.auth, expected);
}

/** What the forwarder Lambda / EventBridge deliver in the `/invocations` payload. */
export type AgentcoreEnvelope = {
  /** Shared secret proving this envelope came from the forwarder (FASTAGENT_INGRESS_SECRET). */
  auth?: string;
  wake?: { url: string };
} & (
  | {
      kind: "webhook";
      /** Original webhook request line, verbatim. */
      method: string;
      path: string;
      /**
       * Original raw query string (no leading `?`) — "verbatim" includes it; a channel reading
       * `request.url.searchParams` must see what the webhook sender sent.
       */
      query?: string;
      /** Original headers — signature material (secret tokens, Feishu signatures) rides here. */
      headers?: Record<string, string>;
      /** Original body, base64 (webhook bodies are JSON but the tunnel must be byte-exact). */
      bodyB64?: string;
    }
  | {
      kind: "routine-fire";
      name: string;
      /**
       * The instant EventBridge scheduled this fire for — the clock's NAME for the occurrence, stable across its
       * redeliveries (measured: 3 attempts of one fire, byte-identical payload). The container dedupes on it and
       * never recomputes it.
       */
      occurrence: string;
    }
  | { kind: "invoke"; session: string; text: string }
  /**
   * An EventBridge wake-up poke: the invocation ITSELF is the payload — it wakes the container, whose boot drain / 30s
   * wake pump then fires whatever is due.
   */
  | { kind: "wake-poke" }
  /**
   * The deploy driver's post-deploy verification (relayed by the forwarder's reserved probe path, which answers on
   * EVERY forwarder topology — schedule-only URLs refuse ordinary public traffic).
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

/** One desired alarm: mirror of a pending wake-up (id names the EventBridge schedule; at = fireAt). */
export interface WakeAlarm {
  id: string;
  at: string;
}

/** The wire shape the wake sink POSTs to {@link RESERVED_PATHS.wakeAlarm} (the forwarder validates `secret`). */
export interface WakeAlarmRequest {
  secret: string;
  alarms: WakeAlarm[];
}

/**
 * What EventBridge hands the forwarder when a cron rule fires: which schedule, and which occurrence of it.
 * `occurrence` is `<aws.scheduler.scheduled-time>` — the clock names its own fire, which is the only thing that
 * survives a retry (schedule/run.ts).
 */
export interface ScheduleFireEvent {
  scheduleFire: { name: string; occurrence: string };
}
