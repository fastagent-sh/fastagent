/**
 * The wire between the forwarder Lambda and the container, in ONE place: the envelope every
 * trigger arrives as, the webhook reply, the wake-alarm request, and the forwarder's reserved paths. The forwarder itself is JavaScript
 * (`deploy/agentcore/forwarder.js`) and cannot import this, so `agentcore-forwarder.test.ts` pins its
 * literals to these — a rename here fails there, not on a live box.
 *
 * Pure types and constants: the adapter, the wake sink and the deploy driver all
 * read it, and none of them may pull the others in for it.
 */

/** Paths the forwarder answers ITSELF — never forwarded to a channel route. */
export const RESERVED_PATHS = {
  /** The deploy driver's post-deploy verification (ingress secret). */
  probe: "/__fastagent/probe",
  /** The container's wake-alarm mirror callback (wake secret). */
  wakeAlarm: "/__fastagent/wake-alarm",
} as const;

/** Every kind the container's `POST /invocations` dispatches on. Listed as a value so the forwarder
 *  pin test can check each one is spelled the same on the other side. */
export const ENVELOPE_KINDS = ["webhook", "schedule-fire", "invoke", "wake-poke", "probe"] as const;

/** What the forwarder Lambda / EventBridge deliver in the `/invocations` payload. Every kind may
 *  carry `wake` — the forwarder's self-resolved public URL, which the adapter persists so the wake
 *  ALARM sink (schedule/wake-alarm.ts) can call back without the URL being baked anywhere. */
export type AgentcoreEnvelope = {
  /** Shared secret proving this envelope came from the forwarder (FASTAGENT_INGRESS_SECRET). The
   *  public `invoke` data plane neither has nor needs it — and may not carry the fields below. */
  auth?: string;
  wake?: { url: string };
} & (
  | {
      kind: "webhook";
      /** Original webhook request line, verbatim. `path` must be absolute ("/telegram"). */
      method: string;
      path: string;
      /** Original raw query string (no leading `?`) — "verbatim" includes it; a channel reading
       *  `request.url.searchParams` must see what the webhook sender sent. */
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
  /** An EventBridge wake-up poke: the invocation ITSELF is the payload — it wakes the container,
   *  whose boot drain / 30s wake pump then fires whatever is due. The handler only acks. */
  | { kind: "wake-poke" }
  /** The deploy driver's post-deploy verification (relayed by the forwarder's reserved probe path,
   *  which answers on EVERY forwarder topology — schedule-only URLs refuse ordinary public traffic).
   *  Runs storage initialization + channel construction and answers a TRANSPORT-200 structured verdict
   *  `{ ok, error? }`: the ordinary webhook path folds a non-200 transport into an opaque 502 at the
   *  forwarder, which would strip exactly the diagnostics this probe exists to carry. */
  | { kind: "probe" }
);

/** The webhook envelope's reply: the channel's real HTTP response, ridden inside a transport-200
 *  body so the forwarder can re-emit it verbatim (AgentCore folds a container non-2xx into its own
 *  424 RuntimeClientError). */
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

/** What EventBridge hands the forwarder for a cron slot; `slot` is `<aws.scheduler.scheduled-time>`.
 *  Its sibling, the wake-alarm poke `{ wakePoke: true }`, is minted and read inside the forwarder
 *  alone (`syncAlarms` writes it, the handler reads it), so it has no type here. */
export interface ScheduleFireEvent {
  scheduleFire: { name: string; slot: string };
}
