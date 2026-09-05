import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, setLogLevel } from "../src/log.ts";
import { reportModuleLoadFailures } from "../src/loader.ts";

describe("runtime logger", () => {
  beforeEach(() => {
    vi.stubEnv("FASTAGENT_LOG_LEVEL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setLogLevel("info");
  });
  const lines = () => vi.mocked(console.error).mock.calls.map(([line]) => String(line));

  it.each([
    ["debug", ["DEBUG d", "INFO  i", "WARN  w", "ERROR e"]],
    ["info", ["INFO  i", "WARN  w", "ERROR e"]],
    ["warn", ["WARN  w", "ERROR e"]],
    ["error", ["ERROR e"]],
  ] as const)("emits at or above %s to stderr", (level, expected) => {
    setLogLevel(level);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines()).toEqual(expected);
  });

  it("reads the environment on each emit and lets a valid value override the posture", () => {
    setLogLevel("debug");
    vi.stubEnv("FASTAGENT_LOG_LEVEL", "ERROR");
    log.debug("hidden");
    log.error("shown");
    vi.stubEnv("FASTAGENT_LOG_LEVEL", "debug");
    log.debug("visible after env change");
    expect(lines()).toEqual(["ERROR shown", "DEBUG visible after env change"]);
  });

  it("an empty value uses the current posture without warning", () => {
    setLogLevel("debug");
    log.debug("first");
    setLogLevel("error");
    log.warn("hidden");
    log.error("last");
    expect(lines()).toEqual(["DEBUG first", "ERROR last"]);
  });

  it.each(["verbose-typo", "constructor", "__proto__"])(
    "invalid level %s warns once and preserves logging",
    (value) => {
      vi.stubEnv("FASTAGENT_LOG_LEVEL", value);
      setLogLevel("debug");
      log.debug("first");
      log.debug("second");
      expect(lines()).toEqual([
        `WARN  [fastagent] unknown FASTAGENT_LOG_LEVEL "${value}"; using the posture default`,
        "DEBUG first",
        "DEBUG second",
      ]);
    },
  );

  it("reports module failures through the same runtime logger", () => {
    reportModuleLoadFailures([{ label: "tools/broken.ts", file: "/agent/tools/broken.ts", message: "bad export" }]);
    expect(lines()).toEqual(["WARN  [fastagent] tools/broken.ts failed to load, skipping it — bad export"]);
  });
});
