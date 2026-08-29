import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_SIGNATURE_AGE_S,
  decryptEvent,
  eventSignature,
  signatureFresh,
  timingSafeEqualStr,
  verifySignature,
} from "../src/channels/feishu/crypto.ts";

/** The INVERSE of the channel's decryption, built independently here from the platform's documented
 *  construction (key = sha256(encryptKey), payload = base64(IV ‖ AES-256-CBC ciphertext)) — so the test
 *  pins the algorithm, not the implementation against itself. */
function encryptEvent(encryptKey: string, plaintext: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

describe("decryptEvent", () => {
  it("decrypts the documented AES-256-CBC construction (sha256 key, IV-prefixed, base64)", () => {
    const event = JSON.stringify({ schema: "2.0", event: { message: { content: "你好 lark" } } });
    expect(decryptEvent("test-key", encryptEvent("test-key", event))).toBe(event);
  });

  it("throws on malformed ciphertext and on a payload too short to carry an IV — never a silent empty", () => {
    const payload = Buffer.from(encryptEvent("right-key", "{}"), "base64");
    // CBC ciphertext must be block-aligned. Truncation is deterministic; unlike a wrong-key assertion,
    // it cannot randomly land on valid PKCS#7 padding (AES-CBC is not authenticated).
    const truncated = payload.subarray(0, -1).toString("base64");
    expect(() => decryptEvent("right-key", truncated)).toThrow();
    expect(() => decryptEvent("k", Buffer.from("short").toString("base64"))).toThrow(/too short/);
  });
});

describe("eventSignature / verifySignature", () => {
  it("computes sha256(timestamp + nonce + encryptKey + body) hex — the platform's exact concatenation", () => {
    const expected = createHash("sha256").update('1700000000nonceKEY{"a":1}', "utf8").digest("hex");
    expect(eventSignature("KEY", "1700000000", "nonce", '{"a":1}')).toBe(expected);
  });

  it("verifies a matching signature and rejects a tampered body or header", () => {
    const headers = { timestamp: "17", nonce: "n1", signature: eventSignature("K", "17", "n1", "body") };
    expect(verifySignature("K", headers, "body")).toBe(true);
    expect(verifySignature("K", headers, "tampered")).toBe(false);
    expect(verifySignature("K", { ...headers, nonce: "n2" }, "body")).toBe(false);
  });
});

describe("signatureFresh", () => {
  const now = 1_700_000_000_000; // ms
  const at = (offsetSeconds: number): string => String(Math.floor(now / 1000) + offsetSeconds);

  it("accepts a timestamp inside the window in BOTH directions (a skewed clock runs either way)", () => {
    expect(signatureFresh(at(0), now)).toBe(true);
    expect(signatureFresh(at(-MAX_SIGNATURE_AGE_S), now)).toBe(true);
    expect(signatureFresh(at(MAX_SIGNATURE_AGE_S), now)).toBe(true);
  });

  it("refuses a timestamp outside the window — the replay bound a valid-forever signature lacks", () => {
    expect(signatureFresh(at(-MAX_SIGNATURE_AGE_S - 1), now)).toBe(false);
    expect(signatureFresh(at(MAX_SIGNATURE_AGE_S + 1), now)).toBe(false);
  });

  it("refuses anything that is not a plain integer second count", () => {
    for (const bad of ["", " ", "abc", "-1", "1.5", "1e9", "99999999999999999999"]) {
      expect(signatureFresh(bad, now)).toBe(false);
    }
  });
});

describe("timingSafeEqualStr", () => {
  it("compares equal/unequal strings, including length mismatches (no throw)", () => {
    expect(timingSafeEqualStr("secret", "secret")).toBe(true);
    expect(timingSafeEqualStr("secret", "secreT")).toBe(false);
    expect(timingSafeEqualStr("secret", "secret-longer")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});
