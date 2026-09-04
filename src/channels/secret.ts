/**
 * The ONE constant-time comparison every shared-secret gate uses: a webhook secret token, a
 * signature, a bearer token, an envelope secret. Timing-safe on equal lengths; a length mismatch
 * answers false without leaking a prefix. Non-string input reads as no secret — and an EMPTY
 * expected value never matches, so a gate whose secret was never configured cannot be passed by
 * sending none.
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

export function secretEquals(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
