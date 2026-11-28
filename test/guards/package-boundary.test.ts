import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The workspace's package lines. A package reaches another only by its name, and only one it depends on; the client
 * (`@fastagent-sh/client`) imports no runtime, so its root entry loads where only `fetch` is.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = ["client", "fastagent", "harness-dsh"] as const;
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
const packageOf = (spec: string) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);

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

  it("no package imports cloud-vendor SDKs or @earendil-works/pi-schema", () => {
    const offenders = PACKAGES.flatMap((pkg) =>
      filesUnder(srcOf(pkg)).flatMap((file) =>
        importsOf(file)
          .bare.filter((spec) => spec.startsWith("@aws-sdk/") || spec.startsWith("@earendil-works/pi-schema"))
          .map((spec) => `${relative(repo, file)} → ${spec}`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("@fastagent-sh/client root and ./auth entries reach no Node API and no package but effect, and keep AuthApi off root", () => {
    for (const file of ["index.ts", "auth.ts"] as const) {
      const entry = resolve(srcOf("client"), file);
      const reached = [...staticPackageGraph(entry), ...staticPackageGraph(entry, true)];
      expect(
        reached.filter((spec) => packageOf(spec) !== "effect"),
        file,
      ).toEqual([]);
    }
    const rootText = readFileSync(resolve(srcOf("client"), "index.ts"), "utf8");
    expect(rootText).not.toMatch(/\bconnectAuth\b|\bAuthApi\b/);
  });

  it("@fastagent-sh/harness-dsh stays decoupled from pi-durable, and @fastagent-sh/fastagent never imports @deepseek-ai/*", () => {
    const dshImports = filesUnder(srcOf("harness-dsh")).flatMap((file) =>
      importsOf(file)
        .bare.filter((spec) => spec.startsWith("@earendil-works/pi-durable"))
        .map((spec) => `${relative(repo, file)} → ${spec}`),
    );
    expect(dshImports).toEqual([]);

    const fastagentDsh = filesUnder(srcOf("fastagent")).flatMap((file) =>
      importsOf(file)
        .bare.filter((spec) => spec.startsWith("@deepseek-ai/") || spec.startsWith("@fastagent-sh/harness-dsh"))
        .map((spec) => `${relative(repo, file)} → ${spec}`),
    );
    expect(fastagentDsh).toEqual([]);
  });

  it("node:sqlite is never statically value-imported in any package (lazy-loaded only when SQLite storage opens)", () => {
    const offenders = PACKAGES.flatMap((pkg) =>
      filesUnder(srcOf(pkg))
        .filter((file) => staticPackageGraph(file, true).has("node:sqlite"))
        .map((file) => relative(repo, file)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("harness neutrality: core entries stay free of static harness imports", () => {
  const neutral = ["http/serve.ts", "http/server.ts", "cli/invoke-stream.ts"];
  it("HTTP and stream modules pull no @earendil-works/* package", () => {
    const offenders = neutral.flatMap((entry) =>
      [...staticPackageGraph(resolve(srcOf("fastagent"), entry))]
        .filter((spec) => spec.startsWith("@earendil-works/"))
        .map((spec) => `${entry} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("@fastagent-sh/fastagent root and ./harness entries never statically import pi-durable, chord, or @deepseek-ai/*", () => {
    for (const file of ["index.ts", "harness.ts"] as const) {
      const entry = resolve(srcOf("fastagent"), file);
      const reached = [...staticPackageGraph(entry)];
      expect(
        reached.filter(
          (spec) =>
            spec.startsWith("@earendil-works/pi-durable") ||
            spec.startsWith("@earendil-works/chord") ||
            spec.startsWith("@deepseek-ai/"),
        ),
        file,
      ).toEqual([]);
    }
  });

  it("only harnesses/pi-durable/ imports @earendil-works/pi-durable or @earendil-works/chord across all packages", () => {
    const piDir = resolve(srcOf("fastagent"), "harnesses/pi-durable");
    const offenders = PACKAGES.flatMap((pkg) =>
      filesUnder(srcOf(pkg))
        .filter((file) => !file.startsWith(`${piDir}/`))
        .flatMap((file) =>
          importsOf(file)
            .bare.filter(
              (spec) => spec.startsWith("@earendil-works/pi-durable") || spec.startsWith("@earendil-works/chord"),
            )
            .map((spec) => `${relative(repo, file)} → ${spec}`),
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("no module outside harnesses/pi-durable/ imports pi-durable internals (except harness-loader.ts lazy dynamic import)", () => {
    const fastagentSrc = srcOf("fastagent");
    const piDir = resolve(fastagentSrc, "harnesses/pi-durable");
    const allowed = new Set([
      `${relative(repo, resolve(fastagentSrc, "harnesses/harness-loader.ts"))} → ${relative(repo, resolve(piDir, "runtime.ts"))}`,
    ]);
    const offenders = filesUnder(fastagentSrc)
      .filter((file) => !file.startsWith(`${piDir}/`))
      .flatMap((file) =>
        importsOf(file)
          .relatives.filter((target) => target.startsWith(`${piDir}/`))
          .map((target) => `${relative(repo, file)} → ${relative(repo, target)}`),
      )
      .filter((edge) => !allowed.has(edge));
    expect(offenders).toEqual([]);
  });

  it("definition/ and postgres.ts stay harness-neutral (zero @earendil-works/* runtime imports)", () => {
    const neutralEntries = [
      resolve(srcOf("fastagent"), "postgres.ts"),
      ...filesUnder(resolve(srcOf("fastagent"), "definition")),
    ];
    const offenders = neutralEntries.flatMap((entry) =>
      [...staticPackageGraph(entry)]
        .filter((spec) => spec.startsWith("@earendil-works/"))
        .map((spec) => `${relative(repo, entry)} → ${spec}`),
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

  it("HarnessProvider, PgExecutor, and build-only defineDefinition stay off the fastagent root entry", () => {
    const rootEntry = readFileSync(resolve(srcOf("fastagent"), "index.ts"), "utf8");
    for (const symbol of ["PgExecutor", "defineDefinition", "HarnessProvider"]) {
      expect(rootEntry).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
    const internalEntry = readFileSync(resolve(srcOf("fastagent"), "internal.ts"), "utf8");
    expect(internalEntry).toMatch(/\bdefineDefinition\b/);
  });

  it("client and fastagent re-export the exact same Agent API type set", () => {
    const extractAgentApiTypes = (pkg: "client" | "fastagent"): string[] => {
      const text = readFileSync(resolve(srcOf(pkg), "index.ts"), "utf8");
      const match =
        /export\s+type\s*\{([^}]+)\}\s*from\s*["'](?:\.\/agent-api\.ts|@fastagent-sh\/client\/agent-api)["']/.exec(
          text,
        );
      expect(match, `missing Agent API type re-export in ${pkg}/src/index.ts`).not.toBeNull();
      return (match?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .toSorted();
    };
    expect(extractAgentApiTypes("fastagent")).toEqual(extractAgentApiTypes("client"));
  });

  it("harness-dsh root entry stays minimal without leaking internal adapter symbols", () => {
    const dshRoot = readFileSync(resolve(srcOf("harness-dsh"), "index.ts"), "utf8");
    expect(dshRoot).not.toMatch(/\bDshPg\w+\b/);
    expect(dshRoot).not.toMatch(/\bFastAgentTool\w+\b/);
    expect(Object.keys(manifestOf("harness-dsh").exports).toSorted()).toEqual([".", "./package.json", "./provider"]);
  });
});

describe("the contracts depend on nothing", () => {
  it("each of them pulls no package but the Agent API's Schema", () => {
    expect([...staticPackageGraph(resolve(srcOf("client"), "agent-api.ts"))]).toEqual(["effect/Schema"]);
    expect([...staticPackageGraph(resolve(srcOf("fastagent"), "mcp-api.ts"))]).toEqual([]);
  });
});
