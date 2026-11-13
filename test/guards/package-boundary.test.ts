import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

describe("host boundary: channels, schedules, and start stay decoupled from AgentCore", () => {
  it("none of channels/, schedule/, or cli/commands/start.ts statically imports deploy/agentcore", () => {
    const visited = new Set<string>();
    const offenders: string[] = [];
    const fromRe = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm;
    const check = (entryRel: string): void => {
      const entryAbs = resolve(srcDir, entryRel);
      const walk = (fileAbs: string): void => {
        if (visited.has(fileAbs)) return;
        visited.add(fileAbs);
        const src = readFileSync(fileAbs, "utf8");
        for (const m of src.matchAll(fromRe)) {
          const spec = m[1];
          if (!spec || (!spec.startsWith("./") && !spec.startsWith("../"))) continue;
          const target = resolve(dirname(fileAbs), spec);
          if (target.startsWith(resolve(srcDir, "deploy/agentcore"))) {
            offenders.push(`${entryRel} → ${spec}`);
          } else {
            walk(target);
          }
        }
      };
      walk(entryAbs);
    };
    for (const entry of [
      "channels/serve.ts",
      "channels/telegram/telegram.ts",
      "channels/slack/slack.ts",
      "channels/feishu/feishu.ts",
      "schedule/schedule.ts",
      "schedule/scheduler.ts",
      "schedule/wakeups.ts",
      "cli/commands/start.ts",
    ]) {
      check(entry);
    }
    expect(offenders).toEqual([]);
  });

  it("core never imports channel implementations, deploy/, or cli/; deploy/ never imports cli/", () => {
    const walkFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walkFiles(full));
        else if (entry.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const pkgOf = (fileAbs: string): string => {
      const rel = resolve(fileAbs).slice(srcDir.length + 1);
      if (rel.startsWith("channels/kit/")) return "channel-kit";
      if (rel.startsWith("channels/telegram/")) return "telegram";
      if (rel.startsWith("channels/slack/")) return "slack";
      if (rel.startsWith("channels/feishu/") || rel.startsWith("channels/lark/")) return "feishu";
      if (rel.startsWith("deploy/agentcore/")) return "agentcore";
      if (rel.startsWith("deploy/fly/")) return "fly";
      if (rel.startsWith("deploy/railway/")) return "railway";
      if (rel.startsWith("deploy/")) return "deploy-core";
      if (
        rel.startsWith("cli/") ||
        rel === "cli.ts" ||
        ["dev-supervisor.ts", "open-url.ts", "tunnel.ts", "box-login.ts"].includes(rel)
      ) {
        return "fastagent";
      }
      if (["telegram.ts", "slack.ts", "feishu.ts", "lark.ts"].includes(rel)) return "subpath";
      return "core";
    };
    const importRe = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["'](\.[^"']+)["']/gm;
    const dynRe = /import\(\s*["'](\.[^"']+)["']\s*\)/g;
    const bad: string[] = [];
    const allowed: Record<string, Set<string>> = {
      core: new Set(["core"]),
      "channel-kit": new Set(["channel-kit", "core"]),
      telegram: new Set(["telegram", "channel-kit", "core"]),
      slack: new Set(["slack", "channel-kit", "core"]),
      feishu: new Set(["feishu", "channel-kit", "core"]),
      "deploy-core": new Set(["deploy-core", "core"]),
      fly: new Set(["fly", "deploy-core", "core"]),
      railway: new Set(["railway", "deploy-core", "core"]),
      agentcore: new Set(["agentcore", "deploy-core", "core"]),
    };
    for (const fileAbs of walkFiles(srcDir)) {
      const fromPkg = pkgOf(fileAbs);
      const permit = allowed[fromPkg];
      if (!permit) continue;
      const src = readFileSync(fileAbs, "utf8");
      for (const re of [importRe, dynRe]) {
        for (const m of src.matchAll(re)) {
          const target = resolve(dirname(fileAbs), m[1] as string);
          const toPkg = pkgOf(target);
          if (!permit.has(toPkg)) {
            bad.push(`${fromPkg} (${fileAbs.slice(srcDir.length + 1)}) → ${toPkg} (${m[1]})`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
