/**
 * Canonical Feishu webhook security (reused by Lark compatibility) — PURE: AES event decryption and request
 * signature, exactly as the open platform defines them. When an Encrypt Key is configured in the
 * developer console, every event arrives as `{"encrypt": "<base64>"}` with signature headers; without
 * one, events arrive in plaintext and carry only the verification token in the body. feishu.ts owns the
 * fail-closed policy (which checks run when); this module owns the math.
 *
 *  - Decryption: AES-256-CBC. The key is sha256(encryptKey); the base64 payload is IV (16 bytes) ‖
 *    ciphertext; the plaintext is the event JSON (PKCS#7 padding handled by the cipher).
 *  - Signature: `X-Lark-Signature = sha256(timestamp + nonce + encryptKey + rawBody)` hex, where
 *    rawBody is the VERBATIM request body (the encrypted form) — computed over bytes, so the caller
 *    must pass the raw text, never a re-serialization.
 *  - Freshness: the signature covers the timestamp but says nothing about WHEN, so a valid one stays
 *    valid forever — {@link signatureFresh} bounds it. Kept separate from {@link verifySignature}
 *    rather than folded in, because the two failures need two diagnoses: a wrong key and a skewed
 *    clock are different things to go fix, and one message covering both sends the operator after
 *    the wrong one.
 *
 * Comparisons are constant-time (timingSafeEqual) so neither the signature check nor the verification-
 * token check leaks a timing signal.
 */
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string equality (padded to equal length first — timingSafeEqual demands it). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Decrypt an `{"encrypt": …}` event payload to its plaintext JSON string. Throws on malformed
 * input or invalid padding. AES-CBC is not authenticated, so a wrong key is not mathematically
 * guaranteed to fail padding; the caller verifies signed events before decrypting and JSON-parses every
 * plaintext envelope, turning wrong-key garbage into a 4xx rather than a silent drop. */
export function decryptEvent(encryptKey: string, encryptB64: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const buf = Buffer.from(encryptB64, "base64");
  if (buf.length <= 16) throw new Error("encrypted event payload is too short to carry an IV + ciphertext");
  const decipher = createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

/** The expected `X-Lark-Signature` for a request: sha256(timestamp + nonce + encryptKey + rawBody) hex. */
export function eventSignature(encryptKey: string, timestamp: string, nonce: string, rawBody: string): string {
  return createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${rawBody}`, "utf8").digest("hex");
}

/** How far a signed request's timestamp may sit from ours before it is refused — the replay bound,
 *  the same ±5 minutes the Slack ingress applies. Without it the `seen` ring is the only defence,
 *  and that ring is bounded: once it rolls over, a captured body plus its headers replays and re-runs
 *  the turn. Two-sided because a skewed clock is a real deployment, and a future timestamp is as
 *  unverifiable as an ancient one. */
export const MAX_SIGNATURE_AGE_S = 5 * 60;

/** Whether a signed request's `X-Lark-Request-Timestamp` (Unix SECONDS) is inside the replay window. */
export function signatureFresh(timestamp: string, nowMs: number = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Number.isSafeInteger(seconds) && Math.abs(Math.floor(nowMs / 1000) - seconds) <= MAX_SIGNATURE_AGE_S;
}

/** Whether a request's signature headers verify against the raw body (constant-time). Says nothing
 *  about freshness — see {@link signatureFresh}. */
export function verifySignature(
  encryptKey: string,
  headers: { timestamp: string; nonce: string; signature: string },
  rawBody: string,
): boolean {
  return timingSafeEqualStr(eventSignature(encryptKey, headers.timestamp, headers.nonce, rawBody), headers.signature);
}
