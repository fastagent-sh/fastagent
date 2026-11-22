/** Constant-time comparison shared by secret gates (Agent API bearer keys and envelope secrets). */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

export function secretEquals(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
