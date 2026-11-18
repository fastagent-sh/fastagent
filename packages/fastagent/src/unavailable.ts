/**
 * A failure that passes by itself: the same request, sent again with nothing changed, can succeed (another process
 * still holds the instance, the database is out of reach for a moment). Every other failure needs someone to change
 * something, a value, a permission, the configuration, and a Caller that retries it waits for ever: what decides the
 * Agent API's `unavailable` (retryable) against `internal` where a platform reports an instance that did not open.
 */
export class Unavailable extends Error {}
