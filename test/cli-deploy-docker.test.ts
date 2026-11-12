import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerComposeFile } from "../src/deploy/docker/plan.ts";
import { deploymentName } from "../src/deploy/deployment-name.ts";
import { agentWorkspace, runInProcess } from "./cli-run.ts";
import { resetHostClis } from "./host-cli-double.ts";

vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"));
vi.mock("../src/git.ts", () => import("./git-double.ts"));
vi.mock("../src/deploy/runner.ts", () => import("./host-cli-double.ts"));

afterEach(() => resetHostClis());

describe("cli: deploy docker", () => {
  it("deploy docker generates app-only Compose and keeps user-owned Dockerfile/Compose on re-run", async () => {
    const dir = await agentWorkspace("fa-deploy-docker-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");

    const file = dockerComposeFile(await deploymentName(dir));
    const first = await runInProcess(["deploy", "docker", dir]);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain(
      "Agent API: not served until FASTAGENT_API_KEY is in the environment that runs Compose",
    );
    expect(first.stdout).toContain(
      // One spelling: the generated Compose names the value file itself.
      `docker compose -f ${file} build --pull\ndocker compose -f ${file} up -d\n`,
    );
    const generatedCompose = await readFile(join(dir, file), "utf8");
    expect(generatedCompose).toContain('"127.0.0.1:8787:8787"');
    expect(generatedCompose).not.toContain("cloudflared");

    const customDockerfile = "FROM node:22-slim\nRUN echo custom\n";
    const customCompose = `${generatedCompose}\n# custom ingress belongs to me\n`;
    await writeFile(join(dir, "Dockerfile"), customDockerfile);
    await writeFile(join(dir, file), customCompose);

    const second = await runInProcess(["deploy", "docker", dir]);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("kept Dockerfile");
    expect(second.stderr).toContain(`kept ${file}`);
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toBe(customDockerfile);
    expect(await readFile(join(dir, file), "utf8")).toBe(customCompose);
  });

  it("deploy docker lists the names a deployment needs and writes no value, wherever it came from: no default file, the shell, --env-file", async () => {
    const dir = await agentWorkspace("fa-deploy-names-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      "src/tools/gh.mjs": `export default {
  kind: "fastagent.needs",
  secrets: [{ name: "GH_TOKEN", optional: false }],
  build: () => ({ name: "gh", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ output: [] }) }),
};\n`,
      // What a deployment does not read: neither the development file nor the one `start` reads.
      ".secrets/.env": "GH_TOKEN=from-dev\n",
      ".secrets/production/.env": "GH_TOKEN=from-start\n",
    });
    const clean = { ...process.env };
    delete clean.GH_TOKEN;
    const file = join(dir, "values.env");
    await writeFile(file, "GH_TOKEN=from-file\n");
    const compose = async (args: string[], env: NodeJS.ProcessEnv) => {
      const run = await runInProcess(["deploy", "docker", dir, "--force", ...args], undefined, env);
      expect(run.code, run.stderr).toBe(0);
      return readFile(join(dir, dockerComposeFile(await deploymentName(dir))), "utf8");
    };
    // The Compose file lists the name and holds no value, wherever it came from; neither project file is read.
    for (const written of [
      await compose([], clean),
      await compose(["--env-file", file], clean),
      await compose([], { ...clean, GH_TOKEN: "from-shell" }),
    ]) {
      expect(written).toMatch(/^ {6}GH_TOKEN:$/m);
      for (const value of ["from-dev", "from-start", "from-file", "from-shell"]) expect(written).not.toContain(value);
    }
  });
});
