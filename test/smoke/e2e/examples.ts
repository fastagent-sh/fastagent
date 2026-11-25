/**
 * Verify every production example under `examples/` against the just-packed local tarballs:
 * - Installs all examples in one temporary npm workspace with `@fastagent-sh/*` overridden to the packed `.tgz` files.
 * - Runs `fastagent info --json`, `fastagent build --json`, `fastagent deploy init docker`, and `fastagent deploy check --json` on every agent directory.
 * - Runs `tsc --noEmit` and `node --check` on standalone host/caller `.ts` scripts (`server.ts`, triggers, callers).
 *
 * CI runs this in `package-smoke`: `node test/smoke/e2e/examples.ts <tarball>...`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("../../..", import.meta.url).pathname);
const EXAMPLES_SOURCE = join(REPO_ROOT, "examples");
const SKIP_DIRS = new Set(["node_modules", "dist", ".fastagent", ".tenants", ".secrets"]);

const tarballs = process.argv.slice(2).map((p) => resolve(p));
if (tarballs.length === 0) {
  throw new Error("usage: node test/smoke/e2e/examples.ts <each tarball npm pack wrote>...");
}

const work = mkdtempSync(join(tmpdir(), "fa-examples-"));
const env = { ...process.env, HOME: join(work, "home") };

const sh = (command: string, args: readonly string[], cwd: string): string => {
  console.error(`$ (${relative(work, cwd) || "."}) ${command} ${args.join(" ")}`);
  return execFileSync(command, [...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
};

/** Read each packed tarball's package name from `package/package.json`. */
function mapTarballsByPackageName(paths: readonly string[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const tarball of paths) {
    const raw = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" });
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name !== "string" || parsed.name.length === 0) {
      throw new Error(`tarball ${tarball} has no valid package.json name`);
    }
    byName.set(parsed.name, tarball);
  }
  return byName;
}

/** Collect every directory containing a `package.json` under `root`. */
function findPackageDirs(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    if (existsSync(join(dir, "package.json"))) found.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      visit(join(dir, entry.name));
    }
  };
  visit(root);
  return found.toSorted();
}

/** Rewrite `@fastagent-sh/*` references in a copied example manifest to local tarballs. */
function rewriteManifestToTarballs(pkgPath: string, tarballsByName: ReadonlyMap<string, string>): void {
  const manifest = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const deps = manifest[section];
    if (typeof deps !== "object" || deps === null) continue;
    const record = deps as Record<string, string>;
    for (const dep of Object.keys(record)) {
      const localTarball = tarballsByName.get(dep);
      if (localTarball !== undefined) {
        record[dep] = `file:${localTarball}`;
      }
    }
  }
  writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

try {
  const tarballsByName = mapTarballsByPackageName(tarballs);
  const copiedExamples = join(work, "examples");
  cpSync(EXAMPLES_SOURCE, copiedExamples, {
    recursive: true,
    filter: (src) => {
      const parts = relative(EXAMPLES_SOURCE, src).split("/");
      return !parts.some((part) => SKIP_DIRS.has(part));
    },
  });

  const packageDirs = findPackageDirs(copiedExamples);
  if (packageDirs.length === 0) {
    throw new Error(`no example package.json found under ${copiedExamples}`);
  }

  for (const dir of packageDirs) {
    rewriteManifestToTarballs(join(dir, "package.json"), tarballsByName);
  }

  const overrides: Record<string, string> = {};
  for (const [name, tarball] of tarballsByName) {
    overrides[name] = `file:${tarball}`;
  }

  writeFileSync(
    join(work, "package.json"),
    `${JSON.stringify(
      {
        name: "fastagent-examples-smoke",
        private: true,
        type: "module",
        workspaces: packageDirs.map((dir) => relative(work, dir)),
        devDependencies: {
          "@types/node": "^26.0.0",
        },
        overrides,
      },
      null,
      2,
    )}\n`,
  );

  sh("npm", ["install", "--no-audit", "--no-fund"], work);

  const fastagentBin = join(work, "node_modules", ".bin", "fastagent");
  const tscBin = join(work, "node_modules", ".bin", "tsc");

  const agentDirs = packageDirs.filter((dir) => existsSync(join(dir, "fastagent.config.ts")));
  if (agentDirs.length < 5) {
    throw new Error(`expected at least 5 example agents, found ${agentDirs.length}: ${agentDirs.join(", ")}`);
  }

  for (const agentDir of agentDirs) {
    const label = relative(copiedExamples, agentDir);

    const infoOut = sh(fastagentBin, ["info", "--json"], agentDir);
    const info = JSON.parse(infoOut) as { name?: unknown };
    if (typeof info.name !== "string" || info.name.length === 0) {
      throw new Error(`${label}: fastagent info --json returned no agent name`);
    }

    const buildOut = sh(fastagentBin, ["build", "--json"], agentDir);
    const built = JSON.parse(buildOut) as { dist?: unknown; name?: unknown };
    if (typeof built.dist !== "string" || typeof built.name !== "string" || !existsSync(join(built.dist, "index.js"))) {
      throw new Error(`${label}: fastagent build --json did not emit dist/index.js: ${buildOut}`);
    }

    sh(fastagentBin, ["deploy", "init", "docker"], agentDir);

    const checkOut = sh(fastagentBin, ["deploy", "check", "--json"], agentDir);
    const check = JSON.parse(checkOut) as { ok?: unknown; leaks?: unknown[]; gate?: unknown };
    if (check.ok !== true || (Array.isArray(check.leaks) && check.leaks.length > 0) || check.gate !== undefined) {
      throw new Error(`${label}: fastagent deploy check failed: ${checkOut}`);
    }
  }

  // Type-check and syntax-check standalone host/caller scripts sitting at the top level of each example package.
  const standaloneScripts = packageDirs.flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "fastagent.config.ts")
      .map((entry) => join(dir, entry.name)),
  );
  if (standaloneScripts.length === 0) {
    throw new Error("expected standalone example host/caller .ts scripts, found none");
  }

  const tsconfigPath = join(work, "tsconfig.examples-smoke.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2025",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2025"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        },
        files: standaloneScripts,
      },
      null,
      2,
    )}\n`,
  );

  sh(tscBin, ["-p", tsconfigPath], work);

  for (const script of standaloneScripts) {
    sh(process.execPath, ["--check", script], work);
  }

  console.error(
    `examples smoke: verified ${agentDirs.length} agents (info, build, deploy check) and ${standaloneScripts.length} host/caller scripts (tsc, node --check)`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
