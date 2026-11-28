import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOCKER_TARGET } from "../../../packages/fastagent/src/deploy/container.ts";
import { checkContainer } from "../../../packages/fastagent/src/deploy/preflight.ts";
import { agent } from "./deploy-preflight-fixtures.ts";

const warnings = async (agentDir: string) => {
  const checked = await checkContainer({ agentDir, force: false, target: DOCKER_TARGET });
  if (!checked.ok) throw new Error(checked.gate);
  return checked.messages.filter((m) => m.level === "warn" || m.level === "leak").map((m) => m.text);
};

describe("deploy/preflight: what the container is checked for", () => {
  it("names the container after the program and warns when no model is set", async () => {
    const dir = await agent();
    const checked = await checkContainer({ agentDir: dir, force: false, target: DOCKER_TARGET });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.container.name).toBe("agent");
    expect(await warnings(dir)).toContainEqual(expect.stringMatching(/no model is set in fastagent\.config\.ts/));
  });

  it("a kept ignore that misses the secrets warns NAMING each leaking FILE, value files included", async () => {
    const dir = await agent({ "prod.env": "OPENAI_API_KEY=sk-x\n" });
    await writeFile(join(dir, ".dockerignore"), "**/node_modules\n");
    const leak = (await warnings(dir)).find((text) => /BAKE SECRETS INTO THE IMAGE/.test(text));
    expect(leak).toMatch(/`\.secrets\/auth\.json`/);
    expect(leak).toMatch(/`\.secrets\/\.env`/);
    expect(leak).toMatch(/`prod\.env`/);
  });

  it("stops when the definition does not load: the container would crash-loop", async () => {
    const dir = await agent({ "src/tools/x.ts": "throw new Error('broken tool');\n" });
    const checked = await checkContainer({ agentDir: dir, force: false, target: DOCKER_TARGET });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.gate).toMatch(/definition does not load.*broken tool/s);
  });

  it("warns when a kept Dockerfile drops the deployed marker or the agent's name", async () => {
    const dir = await agent();
    await writeFile(join(dir, "Dockerfile"), "FROM node:24-slim\nENV FASTAGENT_DEPLOYED=1\nRUN npx fastagent build\n");
    expect(await warnings(dir)).toContainEqual(
      expect.stringMatching(/does not set FASTAGENT_NAME.*FASTAGENT_NAME=agent/),
    );
  });

  it("checks @fastagent-sh/harness-dsh dependency and reports Linux container sandbox posture for harness: dsh", async () => {
    const missingPkgDir = await agent({
      "fastagent.config.ts":
        'export default { model: "openai/gpt-5.5", harness: "dsh", sandbox: "read-only", codingTools: ["read", "bash"] };\n',
    });
    const missingChecked = await checkContainer({ agentDir: missingPkgDir, force: false, target: DOCKER_TARGET });
    expect(missingChecked.ok).toBe(true);
    if (!missingChecked.ok) return;
    expect(missingChecked.messages.filter((m) => m.level === "warn").map((m) => m.text)).toContainEqual(
      expect.stringMatching(/harness: "dsh".*@fastagent-sh\/harness-dsh/),
    );
    expect(missingChecked.messages.filter((m) => m.level === "note").map((m) => m.text)).toContainEqual(
      expect.stringMatching(/read-only sandbox.*Landlock.*bubblewrap/),
    );

    const declaredNoBashDir = await agent({
      "fastagent.config.ts":
        'export default { model: "openai/gpt-5.5", harness: "dsh", sandbox: "read-only", codingTools: ["read"] };\n',
      "package.json": JSON.stringify({
        type: "module",
        name: "agent",
        dependencies: { "@fastagent-sh/fastagent": "*", "@fastagent-sh/harness-dsh": "*" },
      }),
    });
    const declaredChecked = await checkContainer({ agentDir: declaredNoBashDir, force: false, target: DOCKER_TARGET });
    expect(declaredChecked.ok).toBe(true);
    if (!declaredChecked.ok) return;
    expect(declaredChecked.messages.filter((m) => m.level === "warn").map((m) => m.text)).not.toContainEqual(
      expect.stringMatching(/@fastagent-sh\/harness-dsh/),
    );
    expect(declaredChecked.messages.filter((m) => m.level === "note").map((m) => m.text)).not.toContainEqual(
      expect.stringMatching(/Landlock/),
    );

    // optionalDependencies does not satisfy a required harness package, and a kept custom Dockerfile skips the generated-image note.
    const optionalOnlyDir = await agent({
      "fastagent.config.ts":
        'export default { model: "openai/gpt-5.5", harness: "dsh", sandbox: "read-only", codingTools: ["read", "bash"] };\n',
      "package.json": JSON.stringify({
        type: "module",
        name: "agent",
        dependencies: { "@fastagent-sh/fastagent": "*" },
        optionalDependencies: { "@fastagent-sh/harness-dsh": "*" },
      }),
      Dockerfile: "FROM node:24-slim\nENV FASTAGENT_DEPLOYED=1\nENV FASTAGENT_NAME=agent\nRUN npx fastagent build\n",
    });
    const optionalChecked = await checkContainer({ agentDir: optionalOnlyDir, force: false, target: DOCKER_TARGET });
    expect(optionalChecked.ok).toBe(true);
    if (!optionalChecked.ok) return;
    expect(optionalChecked.messages.filter((m) => m.level === "warn").map((m) => m.text)).toContainEqual(
      expect.stringMatching(/harness: "dsh".*@fastagent-sh\/harness-dsh/),
    );
    expect(optionalChecked.messages.filter((m) => m.level === "note").map((m) => m.text)).not.toContainEqual(
      expect.stringMatching(/generated Linux image/),
    );

    const extCompatDir = await agent({
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", harness: "dsh" };\n',
      "src/extensions/legacy.ts": 'export default { name: "legacy-ext", tools: [] };\n',
    });
    expect(await warnings(extCompatDir)).toContain(
      'skipping pi-durable extensions on harness "dsh": legacy-ext (portable tools belong in src/tools/)',
    );
  });

  it("detects Bun runtime from bun.lock / packageManager, checks Bun version floor, and recognizes bun run build", async () => {
    const lockedBun = await agent({
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5" };\n',
      "package.json": JSON.stringify({
        type: "module",
        name: "bun-agent",
        packageManager: "bun@1.4.4",
        dependencies: { "@fastagent-sh/fastagent": "*" },
      }),
      "bun.lock": "{}\n",
    });
    const checked = await checkContainer({ agentDir: lockedBun, force: false, target: DOCKER_TARGET });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.container.runtime).toBe("bun");
      expect(checked.container.bunVersion).toBe("1.4.4");
      expect(checked.container.hasLockfile).toBe(true);
      expect(checked.messages.filter((m) => m.level === "warn")).toEqual([]);
    }

    const oldUnlockedBun = await agent({
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", harness: "dsh" };\n',
      "package.json": JSON.stringify({
        type: "module",
        name: "old-bun-agent",
        packageManager: "bun@1.3.13",
        dependencies: { "@fastagent-sh/fastagent": "*" },
      }),
      Dockerfile: "FROM oven/bun:1\nENV FASTAGENT_DEPLOYED=1\nENV FASTAGENT_NAME=old-bun-agent\nRUN bun run build\n",
    });
    const oldWarnings = await warnings(oldUnlockedBun);
    expect(oldWarnings).toContainEqual(expect.stringMatching(/fastagent needs Bun 1\.4\.4 or later/));
    expect(oldWarnings).toContainEqual(expect.stringMatching(/no bun\.lock.*bun install/));
    expect(oldWarnings).toContainEqual(expect.stringMatching(/bun add @fastagent-sh\/harness-dsh/));
    expect(oldWarnings).not.toContainEqual(expect.stringMatching(/does not run `fastagent build`/));

    const rangeBun = await agent({
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5" };\n',
      "package.json": JSON.stringify({
        type: "module",
        name: "range-bun-agent",
        packageManager: "bun@^1.4.4",
        dependencies: { "@fastagent-sh/fastagent": "*" },
      }),
      "bun.lock": "{}\n",
    });
    expect(await warnings(rangeBun)).toContainEqual(
      expect.stringMatching(/not a concrete Bun version tag.*oven\/bun:1/),
    );

    const customHarnessDir = await agent({
      "fastagent.config.ts": 'export default { model: "openai/gpt-5.5", harness: "custom" };\n',
      "package.json": JSON.stringify({
        type: "module",
        name: "custom-harness-agent",
        dependencies: { "@fastagent-sh/fastagent": "*" },
      }),
      "package-lock.json": "{}\n",
    });
    const customChecked = await checkContainer({ agentDir: customHarnessDir, force: false, target: DOCKER_TARGET });
    expect(customChecked.ok).toBe(true);
    if (customChecked.ok) {
      expect(customChecked.messages.map((m) => m.text)).toContainEqual(
        expect.stringMatching(/npm install @fastagent-sh\/harness-custom/),
      );
      expect(customChecked.messages.map((m) => m.text).join("\n")).not.toContain("undefined sandbox");
      expect(customChecked.messages.map((m) => m.text).join("\n")).not.toContain("Landlock");
    }
  });
});
