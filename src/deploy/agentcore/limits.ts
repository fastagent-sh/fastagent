/** The HOST's body ceilings, and the one place they are computed. */

/** AWS Lambda Function URLs accept request payloads up to 6 MB. */
const FUNCTION_URL_REQUEST_LIMIT = 6 * 1000 * 1000;

/** Maximum original webhook body after reserving JSON-envelope overhead and base64 expansion. */
export const MAX_WEBHOOK_BODY_BYTES = Math.floor((FUNCTION_URL_REQUEST_LIMIT * 3) / 4) - (64 << 10);

/** Largest complete AgentCore envelope accepted by the runtime adapter. */
export const MAX_ENVELOPE_BYTES = FUNCTION_URL_REQUEST_LIMIT;
