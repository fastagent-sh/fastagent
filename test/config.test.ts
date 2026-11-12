/**
 * The configuration of an instance: the program's defaults, an instance's values over
 * them, the settings checked against the program's schema, each value with its source. What a reader of the resolved
 * configuration does with it is that reader's test.
 */
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { made, program, reviewer, instance, typedSettings } from "./config-fixtures.ts";

vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"));

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  it("is the program's defaults, each from the program, when no instance gives any", () => {
    const config = resolveConfig(program({ defaults: { model: "a/b", http: { port: 9000 } } }));
    expect(config).toMatchObject({ model: "a/b", http: { port: 9000 }, settings: {} });
    expect(config.sources).toEqual({ model: "program default", "http.port": "program default" });
  });

  it("puts an instance over the defaults key by key: objects merge, so a port leaves api alone", () => {
    const config = resolveConfig(
      reviewer,
      instance({ model: "anthropic/claude-x", http: { port: 9000 }, settings: { repo: "acme/api" } }),
    );
    expect(config).toMatchObject({
      model: "anthropic/claude-x",
      thinkingLevel: "high",
      http: { port: 9000, api: true },
      settings: { repo: "acme/api", digestChannel: "#general" },
    });
    expect(config.sources).toEqual({
      model: "fastagent.json",
      thinkingLevel: "program default",
      "http.port": "fastagent.json",
      "http.api": "program default",
      "settings.repo": "fastagent.json",
      "settings.digestChannel": "program default",
    });
  });

  it.each([
    ["a key the shape does not have", { modle: "a/b" }, "fastagent.json: /modle unknown field"],
    ["a port out of range", { http: { port: 70000 } }, "/http/port expected <= 65535"],
    ["a model that is not provider/modelId", { model: "nomodel" }, '/model must be "provider/modelId"'],
    ["a setting the program does not declare", { settings: { team: "x" } }, "/settings/team unknown field"],
    ["a setting of the wrong type", { settings: { repo: 7 } }, "/settings/repo"],
    ["instructions that are not a list of paths", { instructions: "./AGENTS.md" }, "/instructions"],
    ["a skills list with an empty path", { skills: [""] }, "/skills/0"],
    ["a prompts list naming one directory twice", { prompts: ["./p", "./p"] }, "/prompts"],
  ])("refuses %s, naming the file and the path", (_what, values, message) => {
    expect(() => resolveConfig(reviewer, instance({ settings: { repo: "r" }, ...values }))).toThrow(message);
  });

  it("refuses a required setting no one gave, naming it, and accepts it once the instance does", () => {
    expect(() => resolveConfig(reviewer)).toThrow("the settings of reviewer: /repo missing");
    expect(() => resolveConfig(reviewer, instance({ settings: {} }))).toThrow("/repo missing");
    expect(resolveConfig(reviewer, instance({ settings: { repo: "r" } })).settings).toMatchObject({ repo: "r" });
  });
});

void typedSettings;
