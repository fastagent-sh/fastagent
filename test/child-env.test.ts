import { describe, expect, it } from "vitest";
import { baseEnv, processEnvironment } from "../src/child-env.ts";

describe("baseEnv", () => {
  it("keeps the base list from its source and nothing else, a blank value included as given", () => {
    const source = {
      PATH: "/bin",
      HOME: "/home/a",
      USER: "a",
      SHELL: "/bin/sh",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TZ: "UTC",
      TMPDIR: "/tmp",
      HTTP_PROXY: "http://p",
      HTTPS_PROXY: "http://p",
      NO_PROXY: "localhost",
      AWS_SECRET_ACCESS_KEY: "secret",
      ANTHROPIC_API_KEY: "sk",
      NODE_OPTIONS: "--x",
      SSH_AUTH_SOCK: "/s",
      LCX: "not-LC_",
      TERM: "xterm",
      MISSING: undefined,
    };
    expect(baseEnv(source)).toEqual({
      PATH: "/bin",
      HOME: "/home/a",
      USER: "a",
      SHELL: "/bin/sh",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TZ: "UTC",
      TMPDIR: "/tmp",
      HTTP_PROXY: "http://p",
      HTTPS_PROXY: "http://p",
      NO_PROXY: "localhost",
    });
    expect(baseEnv({})).toEqual({});
  });
});

describe("processEnvironment", () => {
  const inputs = {
    base: { PATH: "/bin", HOME: "/h" },
    secrets: { GH_TOKEN: "t", OTHER: "o", EMPTY: undefined },
    declared: ["GH_TOKEN", "EMPTY", "NOT_GIVEN"],
    packages: { PATH: "/mise/bin:/bin" },
    workdir: "/srv/agent/work",
  };

  it("takes a declared name only when it is held, never one that Object.prototype has", () => {
    const result = processEnvironment({ ...inputs, declared: ["toString", "GH_TOKEN"] }, "/srv/agent");
    expect(Object.hasOwn(result, "toString")).toBe(false);
    expect(result.GH_TOKEN).toBe("t");
  });

  it("is the base, then the declared secrets that are held, then the packages' commands, then the git ceiling", () => {
    expect(processEnvironment(inputs, "/srv/agent")).toEqual({
      PATH: "/mise/bin:/bin",
      HOME: "/h",
      GH_TOKEN: "t",
      GIT_CEILING_DIRECTORIES: "/srv/agent",
    });
  });
});
