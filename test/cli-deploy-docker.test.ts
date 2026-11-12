import { afterEach, describe, expect, it, vi } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerComposeFile } from "../src/deploy/docker/plan.ts";
import { deploymentName } from "../src/deploy/deployment-name.ts";
import { agentWorkspace, runInProcess } from "./cli-run.ts";
import { hostCli, resetHostClis } from "./host-cli-double.ts";

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

  it("says of the Agent API what Docker does: the key is the environment Compose runs in, not a store a deploy sets", async () => {
    const dir = await agentWorkspace("fa-deploy-docker-api-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const clean = { ...process.env } as NodeJS.ProcessEnv;
    delete clean.FASTAGENT_API_KEY;
    const without = await runInProcess(["deploy", "docker", dir], undefined, clean);
    expect(without.stderr).toContain(
      "Agent API: not served until FASTAGENT_API_KEY is in the environment that runs Compose",
    );
    expect(without.stderr).not.toContain("sets on the target");
    // In the shell, with no --from-env: Compose uses it, so the report says it is served, and how to check.
    const withKey = await runInProcess(["deploy", "docker", dir, "--force"], undefined, {
      ...clean,
      FASTAGENT_API_KEY: "k",
    });
    expect(withKey.stderr).toContain("which Compose takes from the environment that runs it");
    expect(withKey.stderr).toContain("check it: fastagent invoke --url");
  });

  it("lists the model's key only when it travels: a key exported in the shell for other tools is not passed into a container that logs in", async () => {
    const dir = await agentWorkspace("fa-deploy-modelkey-", {
      "fastagent.config.ts": `export default { defaults: { model: "anthropic/claude-sonnet-4-5" } };\n`,
    });
    const shell = { ...process.env, ANTHROPIC_API_KEY: "sk-shell" } as NodeJS.ProcessEnv;
    const compose = async (args: string[]) => {
      const run = await runInProcess(["deploy", "docker", dir, "--force", ...args], undefined, shell);
      expect(run.code, run.stderr).toBe(0);
      return readFile(join(dir, dockerComposeFile(await deploymentName(dir))), "utf8");
    };
    const lists = (yaml: string) => /^ {6}ANTHROPIC_API_KEY:$/m.test(yaml);
    // The box logs in (the shell is not a source), so Compose is not told to fill the key.
    expect(lists(await compose([]))).toBe(false);
    // Given the key, by the environment or by a file, it travels and Compose is told.
    expect(lists(await compose(["--from-env"]))).toBe(true);
    const file = join(dir, "given.env");
    await writeFile(file, "ANTHROPIC_API_KEY=sk-file\n");
    expect(lists(await compose(["--env-file", file]))).toBe(true);
  });

  it("deploy docker refuses --run from a generated artifact that drifted from the definition", async () => {
    // Reporting the drift is enough when only producing artifacts. `--run` would deploy FROM it, which is a
    // determinate mismatch between what ships and what the definition says — so it stops before Docker is touched.
    // (writeArtifacts owns WHICH files are stale; this is the dispatcher's wiring of that fact to an exit code.)
    const dir = await agentWorkspace("fa-deploy-stale-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    expect((await runInProcess(["deploy", "docker", dir])).code).toBe(0);
    const compose = join(dir, dockerComposeFile(await deploymentName(dir)));
    // Keep the marker (it is still ours), change the content: drifted, not disowned.
    await writeFile(compose, `${await readFile(compose, "utf8")}# drifted\n`);

    // Build output every deploy writes: a mark left in it shows whether this one wrote anything.
    const output = join(dir, ".fastagent/deploy", "fastagent.packages");
    await writeFile(output, "left by an earlier deploy\n");

    const gated = await runInProcess(["deploy", "docker", dir, "--run"]);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toContain(`deploy stopped: ${dockerComposeFile(await deploymentName(dir))} no longer match`);
    expect(gated.stderr).not.toMatch(/Docker CLI not found|Docker daemon/); // refused before any Docker work
    // Refused before anything is on disk: build output is rewritten unconditionally, so deciding after the writes
    // would print `wrote …` lines above `deploy stopped`.
    expect(await readFile(output, "utf8")).toBe("left by an earlier deploy\n");
    expect(gated.stderr).not.toMatch(/wrote /);
  });

  it("deploy has no --tunnel: public ingress is the operator's, named as http.publicUrl", async () => {
    const dir = await agentWorkspace("fa-deploy-no-tunnel-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const result = await runInProcess(["deploy", "docker", dir, "--tunnel"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--tunnel'");
    await expect(access(join(dir, dockerComposeFile(await deploymentName(dir))))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("deploy docker --run checks the names against the environment Compose will run in, with or without --from-env", async () => {
    // Compose has no other place to take a value from, so the shell counts here whatever `--from-env` says: that flag is
    // about what `deploy` reads for a store, and Docker keeps none.
    const dir = await agentWorkspace("fa-deploy-compose-gate-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      "src/tools/gh.mjs": `export default {
  kind: "fastagent.needs",
  secrets: [{ name: "GH_TOKEN", optional: false }],
  build: () => ({ name: "gh", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ output: [] }) }),
};\n`,
    });
    // A `docker` that has Compose but no daemon: the run gets as far as the values check, then to the daemon check.
    hostCli("docker", ({ args }) => ({ code: args[0] === "compose" && args[1] === "version" ? 0 : 1 }));
    const clean: NodeJS.ProcessEnv = { ...process.env };
    delete clean.GH_TOKEN;
    const missing = await runInProcess(["deploy", "docker", dir, "--run"], undefined, clean);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("deploy stopped: Docker has no value for: GH_TOKEN");
    expect(missing.stderr).not.toContain("Docker daemon is unavailable");
    // Set in the shell, with no --from-env, the name passes and the run reaches the daemon check.
    const given = await runInProcess(["deploy", "docker", dir, "--run", "--force"], undefined, {
      ...clean,
      GH_TOKEN: "x",
    });
    expect(given.stderr).toContain("Docker daemon is unavailable");
    expect(given.stderr).not.toContain("Docker has no value for");
  });
});
