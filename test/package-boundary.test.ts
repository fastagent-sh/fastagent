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

/** Every .ts under src/ — for the checks that read source text rather than the import graph. */
function walkSources(dir: string = srcDir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSources(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function staticPackageGraph(entryRel: string): Set<string> {
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

describe("the assembly's parts stay out of the public surface", () => {
  // Each of these was public once. They are how `createAgentService` builds a service, not something
  // a caller reproduces — and every one re-exported is a promise we then have to keep.
  const PARTS = [
    "router",
    "createControlPlane",
    "loadTools",
    "loadChannels",
    "loadSchedules",
    "discoverScheduleFiles",
    "createScheduler",
    "scheduleSession",
    // pi-ai's own runtime function: forwarding it makes us answerable for an API we do not own.
    "createProvider",
  ];

  // Types the parts drag along: nothing public references them once their producer is internal, so
  // exporting one is a promise with no caller. This list guards against RE-EXPORTING them, which is
  // how each left. It does not — and is not meant to — stop someone declaring a fresh type of the
  // same name at an entry: the wildcard check above already removes every path by which something
  // arrives here unnoticed, and what remains is a line somebody wrote on purpose.
  const ORPHAN_TYPES = ["ChannelCollision", "Scheduler", "SchedulerOptions"];

  it("the curated entries name every export, so nothing rides in behind a wildcard", () => {
    // This is what makes the two checks below sufficient. A `export *` — or `export type *`, which
    // leaves no runtime trace at all — would re-export whatever its target grows next, and neither a
    // name list nor a module import can see that coming.
    for (const entry of ["core.ts", "node.ts", "pi.ts", "session.ts"]) {
      expect(readFileSync(resolve(srcDir, entry), "utf8"), entry).not.toMatch(/export\s+(?:type\s+)?\*/);
    }
    // The root is the all-in-one, and may forward the curated three — but only those.
    const index = readFileSync(resolve(srcDir, "index.ts"), "utf8");
    const targets = [...index.matchAll(/export\s+(?:type\s+)?\*\s+from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(targets.sort()).toEqual(["./core.ts", "./node.ts", "./pi.ts", "./session.ts"]);
  });

  for (const entry of ["core.ts", "pi.ts", "index.ts"]) {
    it(`${entry} exports no assembly part`, async () => {
      // The MODULE, so a later `export *` cannot smuggle one past a regex over the text.
      const mod = (await import(resolve(srcDir, entry))) as Record<string, unknown>;
      expect(PARTS.filter((p) => p in mod)).toEqual([]);
    });

    it(`${entry} exports no orphaned type`, () => {
      // The SOURCE, because a type export leaves no runtime trace for the check above to see.
      const source = readFileSync(resolve(srcDir, entry), "utf8");
      const named = [...source.matchAll(/export (?:type )?\{([^}]*)\}/g)]
        .flatMap((m) => m[1]!.split(","))
        .map((raw) =>
          raw
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        )
        .filter(Boolean);
      expect(named.filter((n) => ORPHAN_TYPES.includes(n))).toEqual([]);
    });
  }
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

  for (const file of readdirSync(KIT).filter((f) => f.endsWith(".ts"))) {
    it(`${file} is used only by platform directories`, () => {
      const strays = importersOf(file).filter((p) => !/^channels\/(kit\/)?[a-z]+\//.test(p));
      expect(strays).toEqual([]);
    });
  }

  it("...and the serving mechanism beside it stays out of the kit", () => {
    for (const file of ["serve.ts", "http.ts", "control.ts", "discover.ts"]) {
      const src = readFileSync(resolve(srcDir, "channels", file), "utf8");
      expect(src.includes("./kit/"), `${file} reaches into the kit`).toBe(false);
    }
  });
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

  it("the three neutral layers each cost exactly what their name promises", () => {
    // Engine-neutral and runtime-neutral are DIFFERENT properties, and the entries are layered by
    // them: /core has both, /node drops the second (a filesystem, a clock, an environment), /pi
    // drops both. Each layer's package list is that statement, checkable.
    expect([...staticPackageGraph("core.ts")]).toEqual([]);
    expect([...staticPackageGraph("node.ts")].sort()).toEqual(["@hono/node-server", "croner"]);
    // ...and neither neutral layer names an engine (the engine-neutrality suite above covers this
    // for core; node now carries the assembly, so it needs the same bar).
    expect([...staticPackageGraph("node.ts")].filter((p) => p.startsWith("@earendil-works/"))).toEqual([]);
  });

  it("every openExternalUrl call prints the URL too — the headless fallback it depends on", () => {
    // `openExternalUrl` swallows its spawn error (no browser on a server is normal), so a caller
    // that does not ALSO print the URL leaves a headless operator staring at a prompt with no way
    // to reach the page. The function's own doc states the obligation; nothing enforced it, and one
    // of the six call sites had already lost it — the Slack resume path, which then asks the
    // operator to paste a token from a page they were never shown.
    const outputs = /console\.(?:error|log|warn)\(|clackLog\.\w+\(/;
    const offenders: string[] = [];
    for (const file of walkSources()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const call = line.match(/openExternalUrl\((\w+)\)/);
        if (!call) return;
        const arg = call[1] as string;
        const window = lines.slice(Math.max(0, i - 12), i).join("\n");
        const printed = window.search(outputs);
        // A HEURISTIC, and worth naming as one: it asks that some output call precede the open and
        // that the argument appear after it. That catches the real miss — an open with nothing
        // printed at all — and it would pass an alias (`const u = url` under a print of `url`),
        // which is fine, since that one did print the URL. What it cannot see is an output call
        // printing an UNRELATED string near an open; proving that needs an AST, and this guard is
        // not worth one.
        if (printed === -1 || !window.slice(printed).includes(arg)) {
          offenders.push(`${relative(srcDir, file)}:${i + 1} opens ${arg} without printing it`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("...and the mechanism that serves them depends on one, for the node bridge only", () => {
    // The guard has teeth: serving pulls a package, contracts pull none. What it pulls is the
    // node:http↔Fetch adapter — dispatch itself is a Map lookup over literal paths, so no routing
    // library is in the graph.
    const pkgs = [...staticPackageGraph("channels/serve.ts")];
    expect(pkgs).toEqual(["@hono/node-server"]);
  });
});
