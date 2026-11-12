import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MISE_PACKAGE_NAMES } from "../src/environment/mise.ts";
import { agent, call } from "./deploy-preflight-fixtures.ts";

describe("deploy/preflight: the host-neutral pre-flight", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** The agent's mise, faked where its platform package puts it: it resolves every name to aqua and logs each lock. */
  async function installMise(dir: string): Promise<() => Promise<string>> {
    const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
    await mkdir(join(pkg, "bin"), { recursive: true });
    await writeFile(join(pkg, "package.json"), "{}\n");
    const runs = join(dir, "..", "mise-runs.log");
    await writeFile(
      join(pkg, "bin", "mise"),
      `#!/bin/sh\necho "$*" >> "${runs}"\ncase "$1" in\n  tool) printf '{"backend":"aqua:o/%s"}' "$2" ;;\nesac\n`,
    );
    await chmod(join(pkg, "bin", "mise"), 0o755);
    return () => readFile(runs, "utf8").catch(() => "");
  }

  const withMise = JSON.stringify({
    type: "module",
    dependencies: { "@fastagent-sh/fastagent": "^1" },
    optionalDependencies: Object.fromEntries(MISE_PACKAGE_NAMES.map((name) => [name, "2026.10.7"])),
  });

  it("packages need the linux mise in package.json, and mise here to check them; deploy installs nothing here", async () => {
    const dir = await agent({
      "package.json": `{"type":"module","dependencies":{"@fastagent-sh/fastagent":"^1"}}`,
      "context.json": JSON.stringify({ environment: { packages: { jq: "1.8.1" }, aptPackages: ["chromium", "git"] } }),
    });
    const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated).toMatchObject({
      ok: false,
      gate: expect.stringMatching(
        /does not list @jdxcode\/mise-linux-arm64, @jdxcode\/mise-linux-x64\. Run `fastagent env install`/,
      ),
    });
    await writeFile(join(dir, "package.json"), withMise);
    // Listed but not installed on this machine (it never installed the agent's dependencies): nothing can be checked,
    // which stops --run and only warns a deploy that writes the artifacts.
    const notHere =
      `the agent's mise is not installed here, so the packages context.json declares cannot be checked. Run ` +
      `\`fastagent env install\` in ${dir}, then deploy again.`;
    expect(await call(dir, { model: "openai/gpt-4o-mini" }, { run: true })).toMatchObject({ ok: false, gate: notHere });
    const artifactsOnly = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(artifactsOnly.ok && artifactsOnly.messages).toContainEqual({ level: "warn", text: notHere });
    const runs = await installMise(dir);
    const checked = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.container.packages).toEqual(["jq@1.8.1"]);
      // mise downloads over TLS (the slim image has no CAs); the agent's own apt packages join the one layer.
      expect(checked.container.apt).toEqual(["ca-certificates", "chromium", "git"]);
    }
    // Checked here; the image installs them.
    expect(await runs()).toBe("tool jq --json\n");
    await writeFile(join(dir, "context.json"), JSON.stringify({ environment: { aptPackages: ["chromium"] } }));
    const none = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(none.ok && none.container.packages).toBeUndefined();
  });
});
