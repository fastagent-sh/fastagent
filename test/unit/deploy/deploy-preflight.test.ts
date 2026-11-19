import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOCKER_TARGET } from "../../../packages/fastagent/src/deploy/container.ts";
import { checkContainer } from "../../../packages/fastagent/src/deploy/preflight.ts";
import { agent } from "./deploy-preflight-fixtures.ts";

vi.mock("../../../packages/fastagent/src/git.ts", () => import("../../doubles/git-double.ts"));

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
});
