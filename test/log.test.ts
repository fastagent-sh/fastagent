import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, log, setLogLevel } from "../src/log.ts";

describe("createLogger", () => {
  const capture = (level: "debug" | "info" | "warn" | "error") => {
    const lines: string[] = [];
    return { log: createLogger({ level, sink: (l) => lines.push(l) }), lines };
  };

  it("gates below the threshold and emits at or above it", () => {
    const { log, lines } = capture("info");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toEqual(["INFO  i", "WARN  w", "ERROR e"]); // debug dropped
  });

  it("at debug level emits everything", () => {
    const { log, lines } = capture("debug");
    log.debug("d");
    log.info("i");
    expect(lines).toEqual(["DEBUG d", "INFO  i"]);
  });

  it("at error level emits only errors", () => {
    const { log, lines } = capture("error");
    log.warn("w");
    log.error("e");
    expect(lines).toEqual(["ERROR e"]);
  });
});

describe("log singleton + setLogLevel", () => {
  // Assumes FASTAGENT_LOG_LEVEL is unset: a valid one wins at every emit and would gate these lines.
  it("setLogLevel moves the threshold; the singleton writes to stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setLogLevel("debug");
      log.debug("[t] d");
      setLogLevel("error");
      log.warn("[t] w"); // below error — gated
      log.error("[t] e");
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("DEBUG [t] d");
      expect(lines).toContain("ERROR [t] e");
      expect(lines.some((l) => l.includes("[t] w"))).toBe(false);
    } finally {
      err.mockRestore();
      setLogLevel("info"); // restore the default the other suites rely on
    }
  });
});

describe("FASTAGENT_LOG_LEVEL override (read per emit)", () => {
  // The env is stubbed AFTER log.ts is imported — the shape a `.secrets/.env` has (#451): the file lands
  // in process.env long after every command module has pulled this one in.
  afterEach(() => {
    vi.unstubAllEnvs();
    setLogLevel("info"); // restore the default the other suites rely on
  });

  it("a valid value set after import wins over the posture", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setLogLevel("debug");
      vi.stubEnv("FASTAGENT_LOG_LEVEL", "error");
      log.debug("[t] d");
      log.error("[t] e");
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("ERROR [t] e");
      expect(lines.some((l) => l.includes("[t] d"))).toBe(false); // debug gated by the override
    } finally {
      err.mockRestore();
    }
  });

  it("an empty value is absent, not a typo — `KEY=` parks a key in a .env", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubEnv("FASTAGENT_LOG_LEVEL", "");
      setLogLevel("debug");
      log.debug("[t] d4");
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("DEBUG [t] d4"); // the posture applies
      expect(lines.some((l) => /unknown FASTAGENT_LOG_LEVEL/.test(l))).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it("an invalid value warns once and falls back to the posture", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubEnv("FASTAGENT_LOG_LEVEL", "verbose-typo"); // a value used nowhere else: the warn-once state is module-level and never reset
      setLogLevel("debug"); // the invalid value did not disable the posture default
      log.debug("[t] d2");
      log.debug("[t] d3");
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => /unknown FASTAGENT_LOG_LEVEL "verbose-typo"/.test(l))).toHaveLength(1);
      expect(lines.some((l) => l.includes("[t] d2"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });
});
