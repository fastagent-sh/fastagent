import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function staticPackageGraph(entryRel: string, builtins = false): Set<string> {
  const visited = new Set<string>();
  const packages = new Set<string>();
  // `import type` / `export type` are erased at compile time, so they cost a consumer nothing. A
  // graph that counted them would report a dependency the published .js does not have.
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

/** What the package exports: its one entry, the HTTP client's, and each first-party channel's. */
const PUBLIC_ENTRIES = ["index.ts", "client.ts", "telegram.ts", "slack.ts", "feishu.ts", "lark.ts"];

describe("package boundary: embed entry stays free of CLI-only dependencies", () => {
  it("the ./client subpath runs wherever fetch does: no Node API, no harness, no server", () => {
    const reached = [...staticPackageGraph("client.ts"), ...staticPackageGraph("client.ts", true)];
    expect(reached.filter((p) => p !== "effect" && !p.startsWith("effect/"))).toEqual([]);
  });
});

describe("harness neutrality: the contracts and the channel spine import no harness package", () => {
  // The contract and the N-side that consumes only the contract must never pull `@earendil-works/*`: that coupling
  // belongs only in the harness (src/harnesses/), which the root entry opens.
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
  // knip's own config says a forgotten entry "surfaces as its whole tree reported dead". That is only
  // true for a subpath nothing else re-exports: `src/node.ts` was missing for as long as it has
  // existed, and knip stayed silent because `index.ts` re-exports it. The claim needs its own check.
  it("every exported subpath has a knip entry", () => {
    const pkg = JSON.parse(readFileSync(resolve(srcDir, "../package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    // Read the `entry` ARRAY, not the file: a substring match over the whole config is satisfied by a
    // path sitting in `ignore` or `project`, or merely named in a comment — which is the misconfigured
    // shape this test exists to catch, not a passing one.
    //
    // Every comment in knip.jsonc is a whole-line `//`, and stripping only those keeps the `$schema`
    // URL's own `//` intact. A trailing or block comment makes JSON.parse throw, which is the right
    // outcome: better a loud failure here than a silently mis-read config.
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

describe("the assembly's parts stay out of the public surface", () => {
  // Each of these was public once. They are how `createAgentService` builds a service, not something
  // a caller reproduces — and every one re-exported is a promise we then have to keep.
  const PARTS = [
    "router",
    "createControlPlane",
    "loadTools",
    "loadChannels",
    "loadSchedules",
    "createScheduler",
    "scheduleSession",
    // pi-ai's own runtime function: forwarding it makes us answerable for an API we do not own.
    "createProvider",
  ];

  it("the entries name every export, so nothing rides in behind a wildcard", () => {
    // This is what makes the two checks below sufficient. A `export *` — or `export type *`, which
    // leaves no runtime trace at all — would re-export whatever its target grows next, and neither a
    // name list nor a module import can see that coming.
    for (const entry of PUBLIC_ENTRIES) {
      expect(readFileSync(resolve(srcDir, entry), "utf8"), entry).not.toMatch(/export\s+(?:type\s+)?\*/);
    }
  });

  const ENTRIES = ["index.ts"];

  it("no entry exports an assembly part", async () => {
    // The MODULE, so a later `export *` cannot smuggle one past a regex over the text.
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      const mod = (await import(resolve(srcDir, entry))) as Record<string, unknown>;
      offenders.push(...PARTS.filter((p) => p in mod).map((p) => `${entry} → ${p}`));
    }
    expect(offenders).toEqual([]);
  });
});

describe("channels/kit is defined by who imports it", () => {
  // The split is a FACT about consumers, not a filing preference: a kit file is one that only a
  // platform directory uses. `wait-health.ts` and `registration.ts` live one level up precisely
  // because deploy/ and cli/ use them too. Checking the direction of imports would not have caught
  // that — this walks the actual importers.
  const KIT = resolve(srcDir, "channels/kit");

  const importersOf = (file: string): string[] => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && readFileSync(p, "utf8").includes(`kit/${file}"`)) {
          found.push(relative(srcDir, p));
        }
      }
    };
    walk(srcDir);
    return found;
  };

  it("every kit file is used only by platform directories", () => {
    const offenders = readdirSync(KIT)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((file) =>
        importersOf(file)
          .filter((p) => !/^channels\/(kit\/)?[a-z]+\//.test(p))
          .map((p) => `${file} ← ${p}`),
      );
    expect(offenders).toEqual([]);
  });

  it("...and the serving mechanism beside it stays out of the kit", () => {
    for (const file of ["serve.ts", "router.ts", "discover.ts"]) {
      const src = readFileSync(resolve(srcDir, "channels", file), "utf8");
      expect(src.includes("./kit/"), `${file} reaches into the kit`).toBe(false);
    }
  });
});

describe("the contracts depend on nothing", () => {
  // agent-api.ts (what every caller speaks) and channel.ts (what a trigger implements) are the product contracts, and
  // sign-in-api.ts what a host embedding agents keeps credentials and signs in with, so it needs no harness. The
  // bar is Effect's Schema for the first, in which the Agent API is written so that its HTTP binding is built from the
  // same schemas, and ZERO for the second rather than "no harness": an agent directory's hand-written channel imports
  // ChannelModule, and the day that type drags in an HTTP framework, every such file inherits it. This is the check
  // that keeps the split honest, and it is why serving lives in channels/serve.ts instead.
  it("each of them pulls no package but the Agent API's Schema", () => {
    expect([...staticPackageGraph("agent-api.ts")]).toEqual(["effect/Schema"]);
    expect([...staticPackageGraph("channel.ts")]).toEqual([]);
    expect([...staticPackageGraph("sign-in-api.ts")]).toEqual([]);
    expect([...staticPackageGraph("mcp-api.ts")]).toEqual([]);
  });
});
