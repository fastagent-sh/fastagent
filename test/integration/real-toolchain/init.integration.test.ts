import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fastagentBuild } from "../../../packages/fastagent/src/version.ts";
import { runInProcess } from "../../doubles/cli-run.ts";
import { hermeticGit } from "../../doubles/git-env.ts";
import { cliInit, exists, freshDir, withIdentity } from "../../fixtures/init-fixtures.ts";

/** Build a minimal valid `.tgz` archive containing the given relative files under `package/`. */
function makePackageTarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const content = Buffer.from(text, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(`package/${rel}`, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0")}\0`,
      136,
      12,
      "ascii",
    );
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function exactVersion(range: string): string {
  return range.replace(/^[\^~>=]+/, "");
}

/** Loopback mock npm registry serving minimal packages for offline real-npm init tests. */
async function startMockRegistry(packages: Record<string, { version: string; postinstall?: string }>) {
  const tarballs = new Map<string, Buffer>();
  const manifests = new Map<string, { version: string; tarballPath: string; shasum: string }>();

  for (const [name, spec] of Object.entries(packages)) {
    const pkgJson = JSON.stringify({
      name,
      version: spec.version,
      type: "module",
      ...(spec.postinstall === undefined ? {} : { scripts: { postinstall: spec.postinstall } }),
    });
    const tgz = makePackageTarball({ "package.json": `${pkgJson}\n`, "index.js": "export {};\n" });
    const tarballPath = `/tarballs/${encodeURIComponent(name)}-${spec.version}.tgz`;
    tarballs.set(tarballPath, tgz);
    manifests.set(name, {
      version: spec.version,
      tarballPath,
      shasum: createHash("sha1").update(tgz).digest("hex"),
    });
  }

  let baseUrl = "";
  const server = createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] as string;
    const tgz = tarballs.get(urlPath);
    if (tgz !== undefined) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgz);
      return;
    }
    const pkgName = decodeURIComponent(urlPath.slice(1));
    const meta = manifests.get(pkgName);
    if (meta === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const spec = packages[pkgName] as { version: string; postinstall?: string };
    const body = {
      name: pkgName,
      "dist-tags": { latest: meta.version },
      versions: {
        [meta.version]: {
          name: pkgName,
          version: meta.version,
          ...(spec.postinstall === undefined ? {} : { scripts: { postinstall: spec.postinstall } }),
          dist: {
            tarball: `${baseUrl}${meta.tarballPath}`,
            shasum: meta.shasum,
          },
        },
      },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    url: baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("init: scaffoldAgent", () => {
  it("makes the agent a git repository with the scaffold as its first commit, and says when it does not", async () => {
    const env = withIdentity;
    const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    const base = await realpath(await freshDir());

    expect(await cliInit(["init", "mine", "--no-install"], base, env)).toContain(
      "git: created a git repository, with the scaffold as its first commit",
    );
    const mine = join(base, "mine");
    expect(git(["rev-parse", "--show-toplevel"], mine)).toBe(mine);
    expect(git(["log", "--format=%s"], mine)).toBe("Create the agent with fastagent");
    expect(git(["status", "--porcelain"], mine)).toBe("");
    expect(git(["ls-files"], mine).split("\n")).toEqual(
      expect.arrayContaining(["fastagent.config.ts", "SYSTEM.md", ".gitignore", ".secrets/.env.example"]),
    );

    const outer = join(base, "agents");
    await mkdir(outer);
    git(["init", "--quiet"], outer);
    expect(await cliInit(["init", "inner", "--no-install"], outer, env)).toContain(
      `git: inside the git repository ${outer}: it tracks the agent, so none was created`,
    );
    expect(await exists(join(outer, "inner", ".git"))).toBe(false);
    await writeFile(join(outer, ".gitignore"), "*\n");
    expect(await cliInit(["init", "ignored", "--no-install"], outer, env)).toContain(
      "git: created a git repository, with the scaffold as its first commit",
    );
    expect(git(["rev-parse", "--show-toplevel"], join(outer, "ignored"))).toBe(join(outer, "ignored"));

    const noIdentity = {
      ...hermeticGit,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
    };
    expect(await cliInit(["init", "anon", "--no-install"], base, noIdentity)).toMatch(
      /git: created a git repository, but its first commit failed \(.+\): commit the scaffold yourself/,
    );
    expect(await exists(join(base, "anon", ".git"))).toBe(true);

    const out = await cliInit(["init", "plain", "--no-install"], base, { ...env, PATH: "/nonexistent" });
    expect(out).toContain("git: git is not installed: no repository was created");
    expect(await exists(join(base, "plain", "fastagent.config.ts"))).toBe(true);
  });

  it("handles failed postinstall, resumes cleanly on retry, becomes a no-op once ready, and supports npm workspaces without touching host files", async () => {
    const base = await realpath(await freshDir());
    const cacheDir = join(base, ".npm-cache");
    const failFlag = join(base, "fail-postinstall");
    const runLog = join(base, "postinstall-runs.log");
    const build = await fastagentBuild();

    const postinstallScript = `node -e ${JSON.stringify(
      `const fs = require("node:fs"); if (fs.existsSync(${JSON.stringify(failFlag)})) process.exit(42); fs.appendFileSync(${JSON.stringify(runLog)}, "ran\\n");`,
    )}`;
    const registry = await startMockRegistry({
      "@fastagent-sh/fastagent": { version: exactVersion(build.version), postinstall: postinstallScript },
      "@earendil-works/pi-durable": { version: exactVersion(build.harness["@earendil-works/pi-durable"] as string) },
      "@earendil-works/pi-ai": { version: exactVersion(build.harness["@earendil-works/pi-ai"] as string) },
      "@earendil-works/pi-schema": { version: exactVersion(build.harness["@earendil-works/pi-schema"] as string) },
      typescript: { version: exactVersion(build.typescript) },
    });

    const npmEnv: NodeJS.ProcessEnv = {
      ...withIdentity,
      npm_config_registry: registry.url,
      npm_config_cache: cacheDir,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    };

    const countRuns = async () =>
      (await exists(runLog)) ? (await readFile(runLog, "utf8")).trim().split("\n").filter(Boolean).length : 0;

    try {
      // 1) Failing postinstall exits non-zero, keeps scaffold & pending marker, never prints ready.
      await writeFile(failFlag, "fail\n");
      const first = await runInProcess(["init", "retry-agent"], base, npmEnv);
      expect(first.code).toBe(1);
      expect(first.stderr).toContain("npm install failed");
      expect(first.stderr).toContain("fastagent init retry-agent");
      expect(first.stderr).not.toContain("already ready");
      const retryDir = join(base, "retry-agent");
      expect(await exists(join(retryDir, "fastagent.config.ts"))).toBe(true);
      expect(await exists(join(retryDir, ".fastagent", "install-pending"))).toBe(true);
      expect(await countRuns()).toBe(0);

      // Fresh standalone scaffold already got its initial git commit even though npm install failed.
      const retryGit = (args: string[]) =>
        execFileSync("git", args, { cwd: retryDir, env: withIdentity, encoding: "utf8" }).trim();
      expect(retryGit(["rev-list", "--count", "HEAD"])).toBe("1");

      // 2) Fix the cause and retry the exact same command: exits 0, clears pending marker, and adds no extra commit.
      await rm(failFlag, { force: true });
      const second = await runInProcess(["init", "retry-agent"], base, npmEnv);
      expect(second.code, second.stderr).toBe(0);
      expect(await exists(join(retryDir, ".fastagent", "install-pending"))).toBe(false);
      expect(await countRuns()).toBe(1);
      expect(retryGit(["rev-list", "--count", "HEAD"])).toBe("1");

      // 3) Third run is a complete no-op: no file edits, no reinstall, no extra commit.
      const beforePkg = await readFile(join(retryDir, "package.json"), "utf8");
      const beforePrompt = await readFile(join(retryDir, "SYSTEM.md"), "utf8");
      const third = await runInProcess(["init", "retry-agent"], base, npmEnv);
      expect(third.code, third.stderr).toBe(0);
      expect(third.stderr).toContain("already ready (no changes)");
      expect(await countRuns()).toBe(1);
      expect(retryGit(["rev-list", "--count", "HEAD"])).toBe("1");
      expect(await readFile(join(retryDir, "package.json"), "utf8")).toBe(beforePkg);
      expect(await readFile(join(retryDir, "SYSTEM.md"), "utf8")).toBe(beforePrompt);

      // 4) --no-install followed by normal init finishes installation.
      const skipped = await runInProcess(["init", "later-agent", "--no-install"], base, npmEnv);
      expect(skipped.code, skipped.stderr).toBe(0);
      expect(skipped.stderr).toContain("skipped (--no-install)");
      expect(await countRuns()).toBe(1);
      const resumed = await runInProcess(["init", "later-agent"], base, npmEnv);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(await countRuns()).toBe(2);

      // 5) Existing CommonJS host application with npm workspaces: root conflicts, child succeeds and preserves host.
      const host = join(base, "host-app");
      await mkdir(join(host, "dist"), { recursive: true });
      const hostPkgRaw = `${JSON.stringify(
        {
          name: "host-app",
          private: true,
          type: "commonjs",
          workspaces: ["agents/*"],
          scripts: { build: "echo host-build" },
        },
        null,
        2,
      )}\n`;
      await writeFile(join(host, "package.json"), hostPkgRaw);
      await writeFile(join(host, "dist", "app.cjs"), "module.exports = 'host';\n");
      await writeFile(join(host, "AGENTS.md"), "# Host repo\n");

      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: host, env: withIdentity, encoding: "utf8" }).trim();
      git(["init", "--quiet"]);
      git(["add", "package.json", "AGENTS.md"]);
      git(["commit", "--quiet", "-m", "Initial host commit"]);
      await writeFile(join(host, "staged.txt"), "keep staged\n");
      git(["add", "staged.txt"]);

      const rootRefused = await runInProcess(["init"], host, npmEnv);
      expect(rootRefused.code).toBe(1);
      expect(rootRefused.stderr).toContain("fastagent init agents/support");
      expect(await readFile(join(host, "package.json"), "utf8")).toBe(hostPkgRaw);

      const childInit = await runInProcess(["init", "agents/support"], host, npmEnv);
      expect(childInit.code, childInit.stderr).toBe(0);
      expect(await countRuns()).toBe(3);
      // Host package, build output, staged work, and commit history remain untouched.
      expect(await readFile(join(host, "package.json"), "utf8")).toBe(hostPkgRaw);
      expect(await readFile(join(host, "dist", "app.cjs"), "utf8")).toBe("module.exports = 'host';\n");
      expect(git(["diff", "--cached", "--name-only"])).toBe("staged.txt");
      expect(git(["rev-list", "--count", "HEAD"])).toBe("1");

      // Re-running init on the workspace child detects hoisted dependencies and performs zero work.
      const childRerun = await runInProcess(["init", "agents/support"], host, npmEnv);
      expect(childRerun.code, childRerun.stderr).toBe(0);
      expect(childRerun.stderr).toContain("already ready (no changes)");
      expect(await countRuns()).toBe(3);

      // A second workspace child with a complete manifest added while only the root lockfile exists still installs.
      const secondChild = join(host, "agents", "billing");
      const prepOnly = await runInProcess(["init", "agents/billing", "--no-install"], host, npmEnv);
      expect(prepOnly.code, prepOnly.stderr).toBe(0);
      expect(await exists(join(host, "package-lock.json"))).toBe(true);
      expect(await exists(join(host, "node_modules", "billing"))).toBe(false);
      expect(await exists(join(secondChild, ".fastagent", "install-pending"))).toBe(false);
      const installSecond = await runInProcess(["init", "agents/billing"], host, npmEnv);
      expect(installSecond.code, installSecond.stderr).toBe(0);
      expect(installSecond.stderr).toContain("installing dependencies (npm install)");
      expect(await exists(join(host, "node_modules", "billing"))).toBe(true);
      const rerunSecond = await runInProcess(["init", "agents/billing"], host, npmEnv);
      expect(rerunSecond.code, rerunSecond.stderr).toBe(0);
      expect(rerunSecond.stderr).toContain("already ready (no changes)");
      expect(rerunSecond.stderr).not.toContain("installing dependencies");
    } finally {
      await registry.close();
    }
  });

  it("adopts an existing git-tracked agent directory without touching git index/history, diagnoses tracked secrets, and lists the author's skill in info --json", async () => {
    const base = await realpath(await freshDir());
    const agent = join(base, "triage");
    await mkdir(join(agent, "skills", "triage"), { recursive: true });
    await mkdir(join(agent, ".secrets"), { recursive: true });
    await writeFile(join(agent, "SYSTEM.md"), "You triage production alerts.\n");
    await writeFile(
      join(agent, "skills", "triage", "SKILL.md"),
      "---\nname: triage\ndescription: Alert triage\n---\nInspect alerts.\n",
    );
    await writeFile(join(agent, ".secrets", ".env"), "OPENAI_API_KEY=sk-tracked\n");

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: agent, env: withIdentity, encoding: "utf8" }).trim();
    git(["init", "--quiet"]);
    git(["add", "SYSTEM.md", "skills/triage/SKILL.md", ".secrets/.env"]);
    git(["commit", "--quiet", "-m", "Author initial prompt and skill"]);
    await writeFile(join(agent, "notes.txt"), "work in progress\n");
    git(["add", "notes.txt"]);

    const adopted = await runInProcess(["init", "--no-install"], agent, withIdentity);
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(adopted.stderr).toContain("already tracked in git");
    expect(adopted.stderr).toContain(".secrets/.env");
    expect(adopted.stderr).toContain("git rm --cached");
    // Git index and history are completely untouched.
    expect(git(["diff", "--cached", "--name-only"])).toBe("notes.txt");
    expect(git(["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(["ls-files", ".secrets/.env"])).toBe(".secrets/.env");
    expect(await exists(join(agent, "skills", "writing-great-skills"))).toBe(false);

    // `fastagent info --json` detects the author's skill right away without requiring model credentials.
    const infoRes = await runInProcess(["info", "--json"], agent, withIdentity);
    expect(infoRes.code, infoRes.stderr).toBe(0);
    const info = JSON.parse(infoRes.stdout) as { commands: Array<{ name: string }> };
    expect(info.commands.map((c) => c.name)).toContain("skill:triage");
    expect(info.commands.map((c) => c.name)).not.toContain("skill:writing-great-skills");
  });
});
