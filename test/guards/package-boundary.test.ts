import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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

const PUBLIC_ENTRIES = ["index.ts", "client.ts", "telegram.ts", "slack.ts", "feishu.ts"];

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
    "channels/kit/body.ts",
    "channels/kit/respond.ts",
    "channels/telegram/telegram.ts",
    "channels/slack/slack.ts",
    "channels/feishu/feishu.ts",
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
    expect([...staticPackageGraph("mcp-api.ts")]).toEqual([]);
  });
});

/**
 * The split ahead (#1051 step 7): `@fastagent-sh/client` holds the contracts, the HTTP client and the channel kit, and
 * each first-party channel becomes a package of its own that imports only the client. Every import, a type's included,
 * must already resolve inside those lines, so the split moves files and changes no code.
 */
describe("the client side and the channels stay inside their future packages", () => {
  const CLIENT = [
    "agent-api.ts",
    "answer-text.ts",
    "atomic-write.ts",
    "channel.ts",
    "channels/kit/",
    "client.ts",
    "http/client.ts",
    "http/contract.ts",
    "log.ts",
    "needs.ts",
    "promise-bridge.ts",
    "runtime-websocket.ts",
    "state-file.ts",
    "strip-edges.ts",
  ];
  const CHANNELS = ["channels/telegram/", "channels/slack/", "channels/feishu/"];
  const inside = (file: string, homes: readonly string[]) =>
    homes.some((home) => (home.endsWith("/") ? file.startsWith(home) : file === home));
  const filesUnder = (dir: string): string[] =>
    readdirSync(resolve(srcDir, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `${dir}${name}`);
  const specifiers = [
    /^\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s*from\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  /** Every import of `file`, static, dynamic or a type's: relative ones as paths under src/, packages by name. */
  const importsOf = (file: string) => {
    const relatives: string[] = [];
    const packages: string[] = [];
    const text = readFileSync(resolve(srcDir, file), "utf8");
    for (const [, spec] of specifiers.flatMap((re) => [...text.matchAll(re)])) {
      if (!spec) continue;
      if (spec.startsWith(".")) relatives.push(relative(srcDir, resolve(srcDir, dirname(file), spec)));
      else packages.push(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec));
    }
    return { relatives, packages };
  };
  const clientFiles = CLIENT.flatMap((home) => (home.endsWith("/") ? filesUnder(home) : [home]));
  const clientPackage = (name: string) => name === "effect" || name === "undici" || name.startsWith("node:");

  it("the client side imports nothing outside it, and no package but effect and undici", () => {
    const offenders = clientFiles.flatMap((file) => {
      const { relatives, packages } = importsOf(file);
      return [
        ...relatives.filter((target) => !inside(target, CLIENT)),
        ...packages.filter((name) => !clientPackage(name)),
      ].map((target) => `${file} → ${target}`);
    });
    expect(offenders).toEqual([]);
  });

  it("a channel imports only its own directory, the client side, and its platform's SDK", () => {
    const offenders = CHANNELS.flatMap((home) =>
      filesUnder(home).flatMap((file) => {
        const { relatives, packages } = importsOf(file);
        const sdk = home === "channels/feishu/" ? ["@larksuiteoapi/node-sdk"] : [];
        return [
          ...relatives.filter((target) => !target.startsWith(home) && !inside(target, CLIENT)),
          ...packages.filter((name) => !clientPackage(name) && !sdk.includes(name)),
        ].map((target) => `${file} → ${target}`);
      }),
    );
    expect(offenders).toEqual([]);
  });
});
