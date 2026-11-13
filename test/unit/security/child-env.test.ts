import { describe, expect, it } from "vitest";
import { processEnvironment } from "../../../src/child-env.ts";

describe("processEnvironment", () => {
  const inputs = {
    base: { PATH: "/bin", HOME: "/h" },
    secrets: { GH_TOKEN: "t", OTHER: "o", EMPTY: undefined },
    declared: ["GH_TOKEN", "EMPTY", "NOT_GIVEN"],
    workdir: "/srv/agent/work",
  };

  it("is the base, then the declared secrets that are held, then the git ceiling", () => {
    expect(processEnvironment(inputs, "/srv/agent")).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GH_TOKEN: "t",
      GIT_CEILING_DIRECTORIES: "/srv/agent",
    });
  });
});
