/**
 * Trimming a run of characters from the ends of a name or a URL (src/strip-edges.ts). The regexes it replaced
 * (`/^-+|-+$/`, `/\/+$/`) backtrack quadratically on a long run that is not at the end, which CodeQL reports as
 * `js/polynomial-redos` and which is slow for a URL or a name somebody else wrote. The old regexes are kept here as the
 * reference, so what the index loop does is proved equal to what they did, and the callers are proved fast.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSlackManifest } from "../src/channels/slack/manifest.ts";
import { agentcoreName, toRuntimeName } from "../src/deploy/agentcore/plan.ts";
import { toDockerProjectName } from "../src/deploy/docker/plan.ts";
import { toFlyAppName } from "../src/deploy/fly/plan.ts";
import { toRailwayName } from "../src/deploy/railway/plan.ts";
import { instanceName } from "../src/instance-name.ts";
import { stripEdges, stripEnd, stripTrailingSlashes } from "../src/strip-edges.ts";

/** Every string up to `length` over `alphabet`, the empty one included. */
function strings(alphabet: readonly string[], length: number): string[] {
  let level = [""];
  const all = [""];
  for (let i = 0; i < length; i++) {
    level = level.flatMap((text) => alphabet.map((char) => text + char));
    all.push(...level);
  }
  return all;
}

describe("what the loop does is what the regexes did", () => {
  const ALPHABET = ["-", "_", "a", "A", "/", "=", ".", "Z", "0"];
  const corpus = strings(ALPHABET, 5);

  const same = (name: string, now: (text: string) => string, before: (text: string) => string) => {
    const different = corpus.filter((text) => now(text) !== before(text));
    expect(different.slice(0, 5), `${name}: ${different.length} of ${corpus.length} differ`).toEqual([]);
  };

  it("at both ends, for a character, for two, and for every one that is not a letter or a digit", () => {
    same(
      "dash",
      (t) => stripEdges(t, (c) => c === "-"),
      (t) => t.replace(/^-+|-+$/g, ""),
    );
    same(
      "underscore",
      (t) => stripEdges(t, (c) => c === "_"),
      (t) => t.replace(/^_+|_+$/g, ""),
    );
    same(
      "dash or underscore",
      (t) => stripEdges(t, (c) => c === "-" || c === "_"),
      (t) => t.replace(/^[-_]+|[-_]+$/g, ""),
    );
    same(
      "not a lowercase letter or a digit",
      (t) => stripEdges(t, (c) => !/[a-z0-9]/.test(c)),
      (t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""),
    );
  });

  it("at the end only, for one character, for two, and for the slash and the padding the callers strip", () => {
    same(
      "dash or underscore",
      (t) => stripEnd(t, (c) => c === "-" || c === "_"),
      (t) => t.replace(/[-_]+$/g, ""),
    );
    same("slash", stripTrailingSlashes, (t) => t.replace(/\/+$/, ""));
    same(
      "equals",
      (t) => stripEnd(t, (c) => c === "="),
      (t) => t.replace(/=+$/, ""),
    );
  });
});

describe("the callers keep what they made of a name", () => {
  it("a Compose project name cut to 54 characters is trimmed again when the cut lands on a separator", () => {
    expect(toDockerProjectName(`${"a".repeat(53)}-bbb`)).toBe(`fastagent-${"a".repeat(53)}`);
    expect(toDockerProjectName("__My Agent__")).toBe("fastagent-my-agent");
    expect(toDockerProjectName("---")).toBe("fastagent-agent");
  });

  it("a name with nothing usable in it falls back, and one with a separator at an end loses it", () => {
    expect([toRailwayName("@@//"), toRailwayName("-api-"), agentcoreName("--Api--"), toRuntimeName("_x_")]).toEqual([
      "agent",
      "api",
      "api",
      "x",
    ]);
    expect([toFlyAppName("--api--"), toFlyAppName("9lives"), toFlyAppName("")]).toEqual([
      "api",
      "app-9lives",
      "app-agent",
    ]);
  });
});

// The test's timeout is the bound: a regex that backtracks on these runs takes over a minute, a linear trim milliseconds.
describe("a long run is not slow at any caller", () => {
  const run = (char: string) => char.repeat(300_000);
  const dashes = `${run("-")}x${run("-")}y`;

  it("for the names the deploy hosts and the instance derive", () => {
    instanceName(dashes);
    toRailwayName(dashes);
    toFlyAppName(dashes);
    agentcoreName(dashes);
    toRuntimeName(dashes);
    toDockerProjectName(dashes);
    expect(toRailwayName(dashes)).toBe(`x${run("-")}y`);
  });

  it("for a URL's slashes, and for a Slack bot's name, which is cut before it is trimmed", () => {
    stripTrailingSlashes(`${run("/")}x${run("/")}`);
    expect(stripTrailingSlashes(`https://x.test${run("/")}`)).toBe("https://x.test");
    expect(
      buildSlackManifest({ name: `${run("-")}Bot${run("-")}`, ingress: "connection" }).features.bot_user.display_name,
    ).toBe("fastagent");
  });
});

describe("no source file trims a run with a regex", () => {
  it("names the file and the line that does", () => {
    const root = join(import.meta.dirname, "../src");
    const trim = /\.replace\(\/[^\n]*\+\$\/[a-z]*,/;
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|js)$/.test(entry.name) && entry.name !== "strip-edges.ts") {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (trim.test(line)) found.push(`${relative(root, path)}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(root);
    expect(found, "use stripEdges, stripEnd or stripTrailingSlashes (src/strip-edges.ts)").toEqual([]);
  });
});
