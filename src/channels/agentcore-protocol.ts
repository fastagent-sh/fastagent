/** The wire between the forwarder Lambda and the container, in ONE place. */

/** Paths the forwarder answers ITSELF — never forwarded to a channel route. */
export const RESERVED_PATHS = {
  /** The deploy driver's post-deploy verification (ingress secret). */
  probe: "/__fastagent/probe",
  /** The container's wake-alarm mirror callback (wake secret). */
  wakeAlarm: "/__fastagent/wake-alarm",
} as const;

/** Every kind the container's `POST /invocations` dispatches on. */
export const ENVELOPE_KINDS = ["webhook", "schedule-fire", "invoke", "wake-poke", "probe"] as const;

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
      kind: "schedule-fire";
      name: string;
      /** The cron instant this fire is FOR (ISO) — the slot-idempotency key. */
      slot: string;
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

/** What EventBridge hands the forwarder for a cron slot; `slot` is `<aws.scheduler.scheduled-time>`. */
export interface ScheduleFireEvent {
  scheduleFire: { name: string; slot: string };
}
