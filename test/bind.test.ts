import { describe, expect, it } from "vitest";
import { answersLocalhost, classifyBind, clientHost, isBindAddress } from "../src/bind.ts";

describe("bind: one reading of a bind address", () => {
  it("accepts IP literals and localhost, rejects anything unbindable", () => {
    for (const ok of ["0.0.0.0", "127.0.0.1", "192.168.1.5", "::", "[::]", "::1", "localhost", "LOCALHOST"]) {
      expect(isBindAddress(ok), ok).toBe(true);
    }
    for (const bad of ["banana", "example.com", "", "127.0.0.1:8787", "[::1", "::1]", "0"]) {
      expect(isBindAddress(bad), bad).toBe(false);
    }
  });

  it("classifies every form of the same reach identically — the parser and the classifier agree", () => {
    // Every spelling of "all interfaces": what isBindAddress accepts, classifyBind must read as wildcard
    // (a bracketed [::] read as `specific` would refuse --tunnel and gate a deploy that is in fact fine).
    for (const w of [undefined, "0.0.0.0", "::", "[::]", "::0"]) expect(classifyBind(w), String(w)).toBe("wildcard");
    for (const l of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(classifyBind(l), l).toBe("loopback");
    }
    for (const s of ["192.168.1.5", "fd00::1"]) expect(classifyBind(s), s).toBe("specific");
  });

  it("answersLocalhost: only the addresses the NAME localhost resolves to (plus wildcard)", () => {
    for (const yes of [undefined, "0.0.0.0", "[::]", "127.0.0.1", "::1", "localhost"]) {
      expect(answersLocalhost(yes), String(yes)).toBe(true);
    }
    // Loopback by reach, but a dial of `localhost` never lands there — the tunnel gate must refuse it.
    for (const no of ["127.0.0.2", "127.0.1.1", "192.168.1.5"]) expect(answersLocalhost(no), no).toBe(false);
  });

  it("derives the address a client dials", () => {
    expect(clientHost(undefined)).toBe("127.0.0.1"); // a wildcard bind answers on loopback
    expect(clientHost("0.0.0.0")).toBe("127.0.0.1");
    expect(clientHost("192.168.1.5")).toBe("192.168.1.5"); // a specific bind only answers as itself
    expect(clientHost("::1")).toBe("[::1]"); // IPv6 needs brackets in a URL
    expect(clientHost("[::1]")).toBe("[::1]"); // …and must not get a second pair
  });
});
