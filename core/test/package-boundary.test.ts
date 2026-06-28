import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the embed/CLI dependency boundary so a future package split stays a packaging change, not a
 * refactor: the public embed entry (index.ts) must never statically pull a CLI-only dependency.
 *
 * "Statically" = what gets eval-loaded when you `import "@kid7st/fastagent"`. We walk the relative
 * import graph from an entry and collect the bare package specifiers reachable through STATIC
 * `import`/`export … from`. Lazy `await import("pkg")` is intentionally excluded (e.g. giget stays
 * lazy in init.ts) — that is the whole point of keeping it lazy.
 */
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function staticPackageGraph(entryRel: string): Set<string> {
  const visited = new Set<string>();
  const packages = new Set<string>();
  const fromRe = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
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
        else if (!spec.startsWith("node:")) packages.add(spec);
      }
    }
  };
  visit(resolve(srcDir, entryRel));
  return packages;
}

const CLI_ONLY = ["@clack/prompts", "undici", "chokidar", "giget"];

describe("package boundary: embed entry stays free of CLI-only dependencies", () => {
  it("index.ts does not statically load any CLI-only dep", () => {
    const pkgs = staticPackageGraph("index.ts");
    for (const dep of CLI_ONLY) expect(pkgs).not.toContain(dep);
  });

  it("octokit lives only behind the ./github subpath, not the root entry", () => {
    expect(staticPackageGraph("index.ts")).not.toContain("@octokit/webhooks-methods");
    expect(staticPackageGraph("github.ts")).toContain("@octokit/webhooks-methods");
  });

  it("the CLI entry is where the CLI-only deps actually live (the guard has teeth)", () => {
    const pkgs = staticPackageGraph("cli.ts");
    expect(pkgs).toContain("@clack/prompts");
    expect(pkgs).toContain("undici");
    expect(pkgs).toContain("chokidar"); // via dev-supervisor.ts
  });
});

describe("engine neutrality: the contract + channel/host spine imports no engine package", () => {
  // The neutral layer (the contract and the N-side that consumes only the contract) must never pull
  // `@earendil-works/*` — that coupling belongs only under engines/pi. Locks the invariant so a
  // stray pi import in agent.ts / a channel / the host is caught here, not in review.
  const neutral = [
    "agent.ts",
    "collect.ts",
    "invoke-stream.ts",
    "channels/http.ts",
    "channels/body.ts",
    "channels/respond.ts",
    "host/node.ts",
  ];
  for (const entry of neutral) {
    it(`${entry} pulls no @earendil-works/* package`, () => {
      const engine = [...staticPackageGraph(entry)].filter((p) => p.startsWith("@earendil-works/"));
      expect(engine).toEqual([]);
    });
  }
});
