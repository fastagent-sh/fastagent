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
  // Assumes FASTAGENT_LOG_LEVEL is unset (an env override would win and skip setLogLevel by design).
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

describe("FASTAGENT_LOG_LEVEL override (parsed at module load)", () => {
  // Each test re-imports a fresh log.ts so the load-time env parse runs under a stubbed value.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("a valid value locks the level — setLogLevel is a no-op", async () => {
    vi.stubEnv("FASTAGENT_LOG_LEVEL", "error");
    vi.resetModules();
    const fresh = await import("../src/log.ts");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fresh.setLogLevel("debug"); // would normally show debug; the valid override wins
      fresh.log.debug("[t] d");
      fresh.log.error("[t] e");
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("ERROR [t] e");
      expect(lines.some((l) => l.includes("[t] d"))).toBe(false); // debug gated by the override
    } finally {
      err.mockRestore();
    }
  });

  it("an invalid value warns at load and falls back to posture — setLogLevel still works", async () => {
    vi.stubEnv("FASTAGENT_LOG_LEVEL", "trace");
    vi.resetModules();
    const err = vi.spyOn(console, "error").mockImplementation(() => {}); // before import — catch the load-time warn
    try {
      const fresh = await import("../src/log.ts");
      expect(err.mock.calls.map((c) => String(c[0])).some((l) => /unknown FASTAGENT_LOG_LEVEL "trace"/.test(l))).toBe(
        true,
      );
      fresh.setLogLevel("debug"); // the invalid value did not disable the posture default
      fresh.log.debug("[t] d2");
      expect(err.mock.calls.map((c) => String(c[0])).some((l) => l.includes("[t] d2"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });
});
