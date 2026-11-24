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
  });
});
