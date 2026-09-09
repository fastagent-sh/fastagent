/**
 * Canonical Feishu webhook security (reused by Lark compatibility) — PURE: AES event decryption and request signature,
 * exactly as the open platform defines them.
 */
import { createDecipheriv, createHash } from "node:crypto";
import { secretEquals } from "../secret.ts";

/**
 * Decrypt an `{"encrypt": …}` event payload to its plaintext JSON string; throws on malformed input or invalid
 * padding. AES-CBC is NOT authenticated, so a wrong key is not mathematically guaranteed to fail padding: the caller
 * must verify a signed event BEFORE decrypting it, and JSON-parse every plaintext envelope afterwards, so wrong-key
 * garbage becomes a 4xx rather than a silent drop.
 */
export function decryptEvent(encryptKey: string, encryptB64: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const buf = Buffer.from(encryptB64, "base64");
  if (buf.length <= 16) throw new Error("encrypted event payload is too short to carry an IV + ciphertext");
  const decipher = createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

/**
 * The expected `X-Lark-Signature` for a request: sha256(timestamp + nonce + encryptKey + rawBody) hex. `rawBody` is
 * the VERBATIM request body (the encrypted form) — the digest is over bytes, so a re-serialization never matches.
 */
export function eventSignature(encryptKey: string, timestamp: string, nonce: string, rawBody: string): string {
  return createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${rawBody}`, "utf8").digest("hex");
}

/** Whether a request's signature headers verify against the raw body (constant-time). */
export function verifySignature(
  encryptKey: string,
  headers: { timestamp: string; nonce: string; signature: string },
  rawBody: string,
): boolean {
  return secretEquals(headers.signature, eventSignature(encryptKey, headers.timestamp, headers.nonce, rawBody));
}
