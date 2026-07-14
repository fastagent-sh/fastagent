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

/** Decrypt an `{"encrypt": …}` event payload to its plaintext JSON string. Throws on malformed input
 *  or a wrong key (bad padding) — the caller turns that into a 4xx, never a silent drop. */
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

/** Whether a request's signature headers verify against the raw body (constant-time). */
export function verifySignature(
  encryptKey: string,
  headers: { timestamp: string; nonce: string; signature: string },
  rawBody: string,
): boolean {
  return timingSafeEqualStr(eventSignature(encryptKey, headers.timestamp, headers.nonce, rawBody), headers.signature);
}
