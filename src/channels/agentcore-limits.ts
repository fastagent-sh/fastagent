/**
 * The HOST's body ceilings, and the one place they are computed.
 *
 * Lambda Function URLs cap a request at 6 MB, so the forwarder cannot deliver more than that no
 * matter what the adapter accepts; the body arrives base64-encoded (×4/3) inside a JSON envelope, so
 * the ORIGINAL body ceiling is smaller still. This is a real capability difference from a resident
 * host — the GitHub channel's own contract is 25 MiB — which is why `deploy agentcore` states it at
 * plan time rather than letting an oversized payload surface as an opaque 502.
 */

/** AWS Lambda Function URLs accept request payloads up to 6 MB. */
const FUNCTION_URL_REQUEST_LIMIT = 6 * 1000 * 1000;

/**
 * Maximum original webhook body after reserving JSON-envelope overhead and base64 expansion.
 * Enforced by both the public forwarder and the runtime adapter.
 */
export const MAX_WEBHOOK_BODY_BYTES = Math.floor((FUNCTION_URL_REQUEST_LIMIT * 3) / 4) - (64 << 10);

/** Largest complete AgentCore envelope accepted by the runtime adapter. */
export const MAX_ENVELOPE_BYTES = FUNCTION_URL_REQUEST_LIMIT;
