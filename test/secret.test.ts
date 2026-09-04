import { describe, expect, it } from "vitest";
import { secretEquals } from "../src/channels/secret.ts";

describe("secretEquals", () => {
  it("compares equal/unequal strings, including length mismatches (no throw)", () => {
    expect(secretEquals("secret", "secret")).toBe(true);
    expect(secretEquals("secret", "secreT")).toBe(false);
    expect(secretEquals("secret", "secret-longer")).toBe(false);
  });

  it("never matches a missing or empty secret, whatever is given", () => {
    // A gate whose secret was never configured must not be passed by sending none.
    expect(secretEquals("", "")).toBe(false);
    expect(secretEquals("", undefined)).toBe(false);
    expect(secretEquals(undefined, "secret")).toBe(false);
    expect(secretEquals(null, "secret")).toBe(false);
    expect(secretEquals(42, "42")).toBe(false);
  });
});
