import { describe, expect, it } from "vitest";
import { readBodyCapped } from "../src/channels/body.ts";

const post = (body: string) => new Request("http://h/", { method: "POST", body });

describe("readBodyCapped", () => {
  it("returns the decoded text when under the cap", async () => {
    const r = await readBodyCapped(post("hello"), 1024);
    expect(r).toEqual({ text: "hello" });
  });

  it("returns tooLarge once the byte count exceeds the cap", async () => {
    const r = await readBodyCapped(post("x".repeat(11)), 10);
    expect(r).toEqual({ tooLarge: true });
  });

  it("counts bytes, not JS characters (multi-byte chars)", async () => {
    // "€" is 3 UTF-8 bytes; 4 of them = 12 bytes > a 10-byte cap, though only 4 characters.
    const r = await readBodyCapped(post("€€€€"), 10);
    expect(r).toEqual({ tooLarge: true });
  });

  it("an empty body is an empty string", async () => {
    const r = await readBodyCapped(new Request("http://h/", { method: "POST" }), 10);
    expect(r).toEqual({ text: "" });
  });
});
