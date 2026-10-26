import { describe, expect, it } from "vitest";
import { describeSecrets, missingSecrets } from "../src/declared-secrets.ts";
import { needs } from "../src/harnesses/pi-durable/define.ts";

describe("declared secrets: the rule", () => {
  it("reports only names with no value, grouped by the file to open", () => {
    const declared = [
      { name: "X_API_KEY", source: "src/tools/x-post.ts" },
      { name: "X_API_SECRET", source: "src/tools/x-post.ts" },
      { name: "SLACK_TOKEN", source: "src/channels/slack.ts" },
    ];
    const env = { X_API_KEY: "k", X_API_SECRET: "" }; // empty counts as missing (an unset .env line)
    expect(missingSecrets(declared, env).map((s) => s.name)).toEqual(["X_API_SECRET", "SLACK_TOKEN"]);
    expect(describeSecrets(declared)).toBe(
      "X_API_KEY, X_API_SECRET (src/tools/x-post.ts); SLACK_TOKEN (src/channels/slack.ts)",
    );
  });

  it("never reports an optional name, unless another declaration requires it, and then names that one", () => {
    const declared = [
      { name: "REGION", source: "src/tools/weather.ts", optional: true },
      { name: "TOKEN", source: "src/tools/a.ts", optional: true },
      { name: "TOKEN", source: "src/tools/b.ts" },
    ];
    expect(missingSecrets(declared, {})).toEqual([{ name: "TOKEN", source: "src/tools/b.ts" }]);
  });
});

describe("declared secrets: the declaration", () => {
  it("a name that is not an env-var name is refused AT THE DECLARATION, naming the value", () => {
    // Written verbatim into env files and deploy artifacts, where a malformed name breaks somewhere far away.
    for (const name of ["MY KEY", "X_API_KEY ", "1TOKEN", ""]) {
      expect(() => needs([name], () => ({}))).toThrow(
        `needs: ${JSON.stringify(name)} is not an environment variable name`,
      );
    }
    expect(needs(["http_proxy", { name: "REGION", optional: true }], () => ({})).secrets).toEqual([
      { name: "http_proxy", optional: false },
      { name: "REGION", optional: true },
    ]);
  });
});
