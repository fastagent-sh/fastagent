import { describe, expect, it } from "vitest";
import {
  deliveredConfig,
  deliveredVariables,
  ownPublicUrl,
  undeliverableText,
  withPublicUrl,
} from "../src/deploy/delivery.ts";

describe("deploy/delivery: what a deploy sets on the box", () => {
  it("delivers the configuration as one line, without the editor's $schema, and {} when there is none", () => {
    expect(deliveredConfig(undefined)).toBe("{}");
    expect(deliveredConfig({ $schema: "./fastagent.schema.json", name: "acme", http: { api: false } })).toBe(
      '{"name":"acme","http":{"api":false}}',
    );
  });

  it("names the public URL the host gives the box, and leaves an operator's own", () => {
    const given = withPublicUrl('{"http":{"api":false}}', "https://bot.fly.dev");
    expect(JSON.parse(given.config)).toEqual({ http: { api: false, publicUrl: "https://bot.fly.dev" } });
    expect(given.publicUrl).toBe("https://bot.fly.dev");
    const own = withPublicUrl('{"http":{"publicUrl":"https://agent.acme.com"}}', "https://bot.fly.dev");
    expect(own).toEqual({
      config: '{"http":{"publicUrl":"https://agent.acme.com"}}',
      publicUrl: "https://agent.acme.com",
    });
    expect(ownPublicUrl("{}")).toBeUndefined();
  });

  it("sets the name, the configuration and a release id that changes only when one of them does", () => {
    const one = deliveredVariables({ agent: "acme", config: '{"a":1}' });
    expect(Object.keys(one)).toEqual(["FASTAGENT_NAME", "FASTAGENT_RELEASE_ID", "FASTAGENT_CONFIG_JSON"]);
    expect(one.FASTAGENT_NAME).toBe("acme");
    expect(one.FASTAGENT_CONFIG_JSON).toBe('{"a":1}');
    // A manifest that holds them is committed: a random id would make every deploy a change to it.
    expect(deliveredVariables({ agent: "acme", config: '{"a":1}' })).toEqual(one);
    expect(deliveredVariables({ agent: "acme", config: '{"a":2}' }).FASTAGENT_RELEASE_ID).not.toBe(
      one.FASTAGENT_RELEASE_ID,
    );
    expect(deliveredVariables({ agent: "globex", config: '{"a":1}' }).FASTAGENT_RELEASE_ID).not.toBe(
      one.FASTAGENT_RELEASE_ID,
    );
    // The id is not the name and the configuration run together: "a" + "bc" is not "ab" + "c".
    expect(deliveredVariables({ agent: "a", config: "bc" }).FASTAGENT_RELEASE_ID).not.toBe(
      deliveredVariables({ agent: "ab", config: "c" }).FASTAGENT_RELEASE_ID,
    );
  });

  it("refuses the text of this machine: a deployment's text is the program's", () => {
    const refusal = undeliverableText({ values: { skills: ["./a"], prompts: ["./b"] }, label: "prod.json" });
    expect(refusal).toMatch(/^prod\.json: skills, prompts name text of this machine/);
    expect(refusal).toContain("AGENTS.md, SYSTEM.md, skills/, prompts/");
    expect(undeliverableText({ values: { name: "acme" }, label: "prod.json" })).toBeUndefined();
    expect(undeliverableText({ values: undefined, label: "prod.json" })).toBeUndefined();
  });
});
