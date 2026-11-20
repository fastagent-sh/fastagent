import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The workspace's package lines. A package reaches another only by its name, and only one it depends on; the client
 * (`@fastagent-sh/client`) imports no runtime, so its root entry loads where only `fetch` is.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = ["client", "fastagent", "agentcore", "pi-remote"] as const;
const srcOf = (name: string) => resolve(repo, "packages", name, "src");
const manifestOf = (name: string) =>
  JSON.parse(readFileSync(resolve(repo, "packages", name, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, unknown>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

const specifiers = [
  /^\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s*from\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];
/** A bare specifier's package: `@scope/name` or `name`. */
const packageOf = (spec: string) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);
/** Every import of the file at `path`, static, dynamic or a type's: relative ones as absolute paths, the rest by spec. */
function importsOf(path: string): { relatives: string[]; bare: string[] } {
  const text = readFileSync(path, "utf8");
  const relatives: string[] = [];
  const bare: string[] = [];
  for (const [, spec] of specifiers.flatMap((re) => [...text.matchAll(re)])) {
    if (!spec) continue;
    if (spec.startsWith(".")) relatives.push(resolve(dirname(path), spec));
    else bare.push(spec);
  }
  return { relatives, bare };
}
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.startsWith("scaffold/templates/"))
    .map((name) => resolve(dir, name));

/**
 * The packages reachable from `entry` through STATIC value imports (`import type` and lazy `await import()` excluded:
 * what loads when the entry is imported), following relative imports; with `builtins`, the `node:` modules instead.
 */
function staticPackageGraph(entry: string, builtins = false): Set<string> {
  const visited = new Set<string>();
  const packages = new Set<string>();
  const fromRe = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm;
  const bareRe = /^\s*import\s+["']([^"']+)["']/gm;
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    for (const re of [fromRe, bareRe]) {
      for (const [, spec] of text.matchAll(re)) {
        if (!spec) continue;
        if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
        else if (builtins === spec.startsWith("node:")) packages.add(spec);
      }
    }
  };
  visit(entry);
  return packages;
}

describe("package lines", () => {
  it("a relative import stays inside its own package's src/", () => {
    const offenders = PACKAGES.flatMap((name) =>
      filesUnder(srcOf(name)).flatMap((file) =>
        importsOf(file)
          .relatives.filter((target) => !target.startsWith(`${srcOf(name)}/`))
          .map((target) => `${relative(repo, file)} → ${relative(repo, target)}`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("a package imports only what its package.json depends on, and Node's own modules", () => {
    const offenders = PACKAGES.flatMap((name) => {
      const manifest = manifestOf(name);
      const declared = new Set([
        manifest.name,
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);
      return filesUnder(srcOf(name)).flatMap((file) =>
        importsOf(file)
          .bare.filter((spec) => !spec.startsWith("node:") && !declared.has(packageOf(spec)))
          .map((spec) => `${relative(repo, file)} → ${spec}`),
      );
    });
    expect(offenders).toEqual([]);
  });

  it("@fastagent-sh/client/agentcore, a Caller's, reaches no Node API and no package but effect and @aws-sdk/client-bedrock-agentcore", () => {
    const entry = resolve(srcOf("client"), "agentcore.ts");
    const packages = [...staticPackageGraph(entry)].map(packageOf);
    expect(packages.filter((p) => p !== "effect" && p !== "@aws-sdk/client-bedrock-agentcore")).toEqual([]);
    expect([...staticPackageGraph(entry, true)]).toEqual([]);
  });

  it("@fastagent-sh/client runs wherever fetch does: its root entry reaches no Node API and no package but effect", () => {
    const entry = resolve(srcOf("client"), "index.ts");
    const reached = [...staticPackageGraph(entry), ...staticPackageGraph(entry, true)];
    expect(reached.filter((spec) => packageOf(spec) !== "effect")).toEqual([]);
  });

  it("@fastagent-sh/pi-remote declares host-provided @earendil-works/pi-* packages only in peerDependencies", () => {
    const manifest = manifestOf("pi-remote");
    const directDeps = Object.keys(manifest.dependencies ?? {}).filter((dep) => dep.startsWith("@earendil-works/"));
    expect(directDeps).toEqual([]);
  });
});

describe("harness neutrality: the Agent API's server imports no harness package", () => {
  const neutral = ["http/serve.ts", "http/server.ts", "cli/invoke-stream.ts"];
  it("none of them pulls an @earendil-works/* package", () => {
    const offenders = neutral.flatMap((entry) =>
      [...staticPackageGraph(resolve(srcOf("fastagent"), entry))]
        .filter((spec) => spec.startsWith("@earendil-works/"))
        .map((spec) => `${entry} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("public entries", () => {
  const entriesOf = (name: string) =>
    Object.keys(manifestOf(name).exports)
      .filter((key) => key !== "./package.json" && !key.includes("*"))
      .map((key) => `packages/${name}/src/${key === "." ? "index" : key.slice(2)}.ts`);

  it("no public entry uses export * or export type *", () => {
    for (const entry of PACKAGES.flatMap(entriesOf)) {
      expect(readFileSync(resolve(repo, entry), "utf8"), entry).not.toMatch(/export\s+(?:type\s+)?\*/);
    }
  });
});

describe("the contracts depend on nothing", () => {
  it("each of them pulls no package but the Agent API's Schema", () => {
    expect([...staticPackageGraph(resolve(srcOf("client"), "agent-api.ts"))]).toEqual(["effect/Schema"]);
    expect([...staticPackageGraph(resolve(srcOf("client"), "agentcore/contract.ts"))]).toEqual([]);
    expect([...staticPackageGraph(resolve(srcOf("client"), "agentcore/contract.ts"), true)]).toEqual([]);
    expect([...staticPackageGraph(resolve(srcOf("fastagent"), "mcp-api.ts"))]).toEqual([]);
  });
});
