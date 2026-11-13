import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the embed/CLI dependency boundary so a future package split stays a packaging change, not a
 * refactor: the public embed entry (index.ts) must never statically pull a CLI-only dependency.
 *
 * "Statically" = what gets eval-loaded when you `import "@fastagent-sh/fastagent"`. We walk the relative
 * import graph from an entry and collect the bare package specifiers reachable through STATIC
 * `import`/`export … from`. Lazy `await import("pkg")` is intentionally excluded (e.g. giget stays
 * lazy in init.ts) — that is the whole point of keeping it lazy.
 */
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function staticPackageGraph(entryRel: string, builtins = false): Set<string> {
  const visited = new Set<string>();
  const packages = new Set<string>();
  const fromRe = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm;
  const bareRe = /^\s*import\s+["']([^"']+)["']/gm;

  const visit = (fileAbs: string): void => {
    if (visited.has(fileAbs)) return;
    visited.add(fileAbs);
    const src = readFileSync(fileAbs, "utf8");
    for (const re of [fromRe, bareRe]) {
      for (const m of src.matchAll(re)) {
        const spec = m[1];
        if (!spec) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) visit(resolve(dirname(fileAbs), spec));
        else if (builtins === spec.startsWith("node:")) packages.add(spec);
      }
    }
  };
  visit(resolve(srcDir, entryRel));
  return packages;
}

const PUBLIC_ENTRIES = ["index.ts", "client.ts", "telegram.ts", "slack.ts", "feishu.ts", "lark.ts"];

describe("package boundary: embed entry stays free of CLI-only dependencies", () => {
  it("the ./client subpath runs wherever fetch does: no Node API, no harness, no server", () => {
    const reached = [...staticPackageGraph("client.ts"), ...staticPackageGraph("client.ts", true)];
    expect(reached.filter((p) => p !== "effect" && !p.startsWith("effect/"))).toEqual([]);
  });
});

describe("harness neutrality: the contracts and the channel spine import no harness package", () => {
  const neutral = [
    "agent-api.ts",
    "channels/router.ts",
    "cli/invoke-stream.ts",
    "channels/body.ts",
    "channels/respond.ts",
    "channels/telegram/telegram.ts",
    "channels/feishu/feishu.ts",
    "channels/lark/lark.ts",
    "channel.ts",
    "channels/serve.ts",
  ];
  it("none of them pulls an @earendil-works/* package", () => {
    const offenders = neutral.flatMap((entry) =>
      [...staticPackageGraph(entry)].filter((p) => p.startsWith("@earendil-works/")).map((p) => `${entry} → ${p}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("knip's entry list mirrors the package's subpath exports", () => {
  it("every exported subpath has a knip entry", () => {
    const pkg = JSON.parse(readFileSync(resolve(srcDir, "../package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    const knip = readFileSync(resolve(srcDir, "../knip.jsonc"), "utf8");
    const { entry } = JSON.parse(
      knip
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    ) as { entry: string[] };
    const missing = Object.keys(pkg.exports)
      .filter((key) => key !== "./package.json")
      .map((key) => (key === "." ? "src/index.ts" : `src/${key.slice(2)}.ts`))
      .filter((subpath) => !entry.includes(subpath));
    expect(missing).toEqual([]);
  });
});

describe("public entries name every export", () => {
  it("no public entry uses export * or export type *", () => {
    for (const entry of PUBLIC_ENTRIES) {
      expect(readFileSync(resolve(srcDir, entry), "utf8"), entry).not.toMatch(/export\s+(?:type\s+)?\*/);
    }
  });
});

describe("the contracts depend on nothing", () => {
  it("each of them pulls no package but the Agent API's Schema", () => {
    expect([...staticPackageGraph("agent-api.ts")]).toEqual(["effect/Schema"]);
    expect([...staticPackageGraph("channel.ts")]).toEqual([]);
    expect([...staticPackageGraph("sign-in-api.ts")]).toEqual([]);
    expect([...staticPackageGraph("mcp-api.ts")]).toEqual([]);
  });
});
