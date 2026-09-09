import { describe, expect, it } from "vitest";
import {
  codePointPrefix,
  truncateCodePointPrefix,
  truncateCodePointSuffix,
  truncateUtf8,
  utf8Prefix,
} from "../src/channels/kit/text.ts";

const isWellFormed = (text: string): boolean => Buffer.from(text, "utf8").toString("utf8") === text;

describe("channel Unicode-safe text truncation", () => {
  it("takes and ellipsizes by code point rather than UTF-16 code unit", () => {
    expect(codePointPrefix("a😀b", 2)).toBe("a😀");
    expect(truncateCodePointPrefix(`${"a".repeat(46)}😀xy`, 48)).toBe(`${"a".repeat(46)}😀…`);
    expect(truncateCodePointSuffix("yx😀ab", 4)).toBe("…😀ab");
  });

  it("answers the marker-decided edges the same way in both directions", () => {
    for (const truncate of [truncateCodePointPrefix, truncateCodePointSuffix]) {
      expect(truncate("abc", 3)).toBe("abc"); // nothing to cut
      expect(truncate("abc", 0)).toBe(""); // no room at all
      expect(truncate("abcd", 2, "...")).toBe(".."); // less room than the marker
      expect(truncate("abcd", 3, "...")).toBe("..."); // exactly the marker's room
    }
  });

  it("takes and ellipsizes a UTF-8 prefix within the exact byte cap", () => {
    expect(utf8Prefix("a😀b", 4)).toBe("a");
    const truncated = truncateUtf8(`${"😀".repeat(10)}z`, 20);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(20);
    expect(truncated.endsWith("…")).toBe(true);
    expect(isWellFormed(truncated)).toBe(true);
  });
});
