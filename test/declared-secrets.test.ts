import { describe, expect, it } from "vitest";
import { describeSecrets, missingSecrets } from "../src/declared-secrets.ts";

describe("declared secrets: the rule", () => {
  it("reports only names with no value, grouped by the file to open", () => {
    const declared = [
      { name: "X_API_KEY", declaredIn: "src/tools/x-post.ts", optional: false },
      { name: "X_API_SECRET", declaredIn: "src/tools/x-post.ts", optional: false },
      { name: "SLACK_TOKEN", declaredIn: "src/channels/slack.ts", optional: false },
    ];
    const env = { X_API_KEY: "k", X_API_SECRET: "" }; // empty counts as missing (an unset .env line)
    expect(missingSecrets(declared, env).map((s) => s.name)).toEqual(["X_API_SECRET", "SLACK_TOKEN"]);
    expect(describeSecrets(declared)).toBe(
      "X_API_KEY, X_API_SECRET (src/tools/x-post.ts); SLACK_TOKEN (src/channels/slack.ts)",
    );
  });
});
