import { describe, expect, it } from "vitest";
import { readBodyCapped } from "../src/channels/body.ts";

const post = (body: string) => new Request("http://h/", { method: "POST", body });

describe("readBodyCapped", () => {
  it("decodes under the cap and reports tooLarge over it, counting BYTES not JS characters", async () => {
    expect(await readBodyCapped(post("hello"), 1024)).toEqual({ text: "hello" });
    expect(await readBodyCapped(new Request("http://h/", { method: "POST" }), 10)).toEqual({ text: "" });
    expect(await readBodyCapped(post("x".repeat(11)), 10)).toEqual({ tooLarge: true });
    // "€" is 3 UTF-8 bytes; 4 of them = 12 bytes > a 10-byte cap, though only 4 characters.
    expect(await readBodyCapped(post("€€€€"), 10)).toEqual({ tooLarge: true });
  });
});
