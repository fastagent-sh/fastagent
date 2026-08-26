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

const CLI_ONLY = ["@clack/prompts", "undici", "chokidar", "giget", "commander"];

describe("package boundary: embed entry stays free of CLI-only dependencies", () => {
  it("index.ts does not statically load any CLI-only dep", () => {
    const pkgs = staticPackageGraph("index.ts");
    for (const dep of CLI_ONLY) expect(pkgs).not.toContain(dep);
  });

  it("octokit lives only behind the ./github subpath, not the root entry", () => {
    expect(staticPackageGraph("index.ts")).not.toContain("@octokit/webhooks-methods");
    expect(staticPackageGraph("github.ts")).toContain("@octokit/webhooks-methods");
  });

  it("the ./telegram subpath is neutral — no engine, no third-party SDK (it is fetch-only)", () => {
    const pkgs = staticPackageGraph("telegram.ts");
    expect([...pkgs].filter((p) => p.startsWith("@earendil-works/"))).toEqual([]);
    expect(pkgs).not.toContain("@octokit/webhooks-methods");
  });

  it("the CLI entry is a thin shell: NO static package loads at all (everything is lazy)", () => {
    // `fastagent <cmd>` pays only for the executed command's module graph — the entry itself must not
    // pull anything eagerly (startup responsiveness, clig).
    expect([...staticPackageGraph("cli.ts")]).toEqual([]);
  });

  it("the CLI-only deps live behind the lazy command modules (the guard has teeth)", () => {
    expect(staticPackageGraph("cli/program.ts")).toContain("commander"); // via kernel.ts
    expect(staticPackageGraph("cli/commands/login.ts")).toContain("@clack/prompts");
    expect(staticPackageGraph("cli/commands/invoke.ts")).toContain("undici"); // via proxy.ts
    expect(staticPackageGraph("cli/commands/dev.ts")).toContain("chokidar"); // via dev-supervisor.ts
  });
});

describe("engine neutrality: the core subpath + channel spine import no engine package", () => {
  // The neutral layer (the contract and the N-side that consumes only the contract) must never pull
  // `@earendil-works/*` — that coupling belongs only in the pi reference implementation.
  const neutral = [
    "core.ts",
    "agent.ts",
    "collect.ts",
    "cli/invoke-stream.ts",
    "channels/http.ts",
    "channels/body.ts",
    "channels/respond.ts",
    "channels/github/github.ts",
    "channels/telegram/telegram.ts",
    "channels/feishu/feishu.ts",
    "channels/lark/lark.ts",
    "channel.ts",
    "channels/serve.ts",
  ];
  for (const entry of neutral) {
    it(`${entry} pulls no @earendil-works/* package`, () => {
      const engine = [...staticPackageGraph(entry)].filter((p) => p.startsWith("@earendil-works/"));
      expect(engine).toEqual([]);
    });
  }

  it("pi.ts is the explicit reference-runtime boundary (the guard has teeth)", () => {
    expect([...staticPackageGraph("pi.ts")].some((p) => p.startsWith("@earendil-works/"))).toBe(true);
  });
});

describe("the public subpaths do not reach into the CLI", () => {
  // A published entry pulling `cli/` drags process-level decisions (`failStartup` calls
  // `process.exit`) into a library someone mounts inside their own app. It also reads as permission
  // to put shared assembly there — which is how `service.ts` came to import `cli/serve.ts` before
  // the parts moved out.
  const relativeGraph = (entryRel: string): Set<string> => {
    const seen = new Set<string>();
    const visit = (fileAbs: string): void => {
      if (seen.has(fileAbs)) return;
      seen.add(fileAbs);
      for (const m of readFileSync(fileAbs, "utf8").matchAll(
        /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
      )) {
        const spec = m[1];
        if (spec?.startsWith("./") || spec?.startsWith("../")) visit(resolve(dirname(fileAbs), spec));
      }
    };
    visit(resolve(srcDir, entryRel));
    return seen;
  };
  for (const entry of ["index.ts", "core.ts", "pi.ts", "session.ts"]) {
    it(`${entry} reaches no cli/ module`, () => {
      const cli = [...relativeGraph(entry)].filter((f) => f.includes(`${srcDir}/cli/`));
      expect(cli.map((f) => f.replace(`${srcDir}/`, ""))).toEqual([]);
    });
  }
});

describe("the contracts depend on nothing", () => {
  // agent.ts (what an engine implements), channel.ts (what a trigger implements) and session.ts (the
  // serving control plane) are the three product contracts — pure types, zero packages. The bar is
  // ZERO rather than "no engine": an agent directory's hand-written channel imports ChannelModule,
  // and the day that type drags in an HTTP framework, every such file inherits it. This is the check
  // that keeps the split honest, and it is why serving lives in channels/serve.ts instead.
  for (const contract of ["agent.ts", "channel.ts", "session.ts"]) {
    it(`${contract} pulls no package at all`, () => {
      expect([...staticPackageGraph(contract)]).toEqual([]);
    });
  }

  it("...and the mechanism that serves them depends on one, for the node bridge only", () => {
    // The guard has teeth: serving pulls a package, contracts pull none. What it pulls is the
    // node:http↔Fetch adapter — dispatch itself is a Map lookup over literal paths, so no routing
    // library is in the graph.
    const pkgs = [...staticPackageGraph("channels/serve.ts")];
    expect(pkgs).toEqual(["@hono/node-server"]);
  });
});
