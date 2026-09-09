import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptEvent, eventSignature, verifySignature } from "../src/channels/feishu/crypto.ts";

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
  it("decrypts the documented AES-256-CBC construction, and THROWS on anything malformed", () => {
    const event = JSON.stringify({ schema: "2.0", event: { message: { content: "你好 lark" } } });
    expect(decryptEvent("test-key", encryptEvent("test-key", event))).toBe(event);
    // CBC ciphertext must be block-aligned. Truncation is deterministic; unlike a wrong-key assertion,
    // it cannot randomly land on valid PKCS#7 padding (AES-CBC is not authenticated). Never a silent empty.
    const payload = Buffer.from(encryptEvent("right-key", "{}"), "base64");
    expect(() => decryptEvent("right-key", payload.subarray(0, -1).toString("base64"))).toThrow();
    expect(() => decryptEvent("k", Buffer.from("short").toString("base64"))).toThrow(/too short/);
  });
});

describe("eventSignature / verifySignature", () => {
  it("is sha256(timestamp + nonce + encryptKey + body) hex, and rejects a tampered body or header", () => {
    // The platform's exact concatenation.
    const expected = createHash("sha256").update('1700000000nonceKEY{"a":1}', "utf8").digest("hex");
    expect(eventSignature("KEY", "1700000000", "nonce", '{"a":1}')).toBe(expected);

    const headers = { timestamp: "17", nonce: "n1", signature: eventSignature("K", "17", "n1", "body") };
    expect(verifySignature("K", headers, "body")).toBe(true);
    expect(verifySignature("K", headers, "tampered")).toBe(false);
    expect(verifySignature("K", { ...headers, nonce: "n2" }, "body")).toBe(false);
  });
});
