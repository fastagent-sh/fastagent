import { describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

describe("cli: deploy docker", () => {
  it("deploy docker generates app-only Compose and keeps user-owned Dockerfile/Compose on re-run", async () => {
    const dir = await agentWorkspace("fa-deploy-docker-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");

    const first = await runInProcess(["deploy", "docker", dir]);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("Agent API: http://127.0.0.1:8787/v1");
    expect(first.stdout).toContain(
      // One spelling: the generated Compose names the value file itself.
      "docker compose -f fastagent.compose.yml build --pull\ndocker compose -f fastagent.compose.yml up -d\n",
    );
    const generatedCompose = await readFile(join(dir, "fastagent.compose.yml"), "utf8");
    expect(generatedCompose).toContain('"127.0.0.1:8787:8787"');
    expect(generatedCompose).not.toContain("cloudflared");

    const customDockerfile = "FROM node:22-slim\nRUN echo custom\n";
    const customCompose = `${generatedCompose}\n# custom ingress belongs to me\n`;
    await writeFile(join(dir, "Dockerfile"), customDockerfile);
    await writeFile(join(dir, "fastagent.compose.yml"), customCompose);

    const second = await runInProcess(["deploy", "docker", dir]);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("kept Dockerfile");
    expect(second.stderr).toContain("kept fastagent.compose.yml");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toBe(customDockerfile);
    expect(await readFile(join(dir, "fastagent.compose.yml"), "utf8")).toBe(customCompose);
  });

  it("deploy docker gates --run when FASTAGENT_SECRETS_DIR sends the values away from the committed env_file", async () => {
    const dir = await agentWorkspace("fa-deploy-secrets-dir-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const elsewhere = await mkdtemp(join(tmpdir(), "fa-secrets-elsewhere-"));
    const env = { ...process.env, FASTAGENT_SECRETS_DIR: elsewhere };

    const planned = await runInProcess(["deploy", "docker", dir], undefined, env);
    expect(planned.code).toBe(0);
    expect(planned.stderr).toMatch(/warn: FASTAGENT_SECRETS_DIR points this run's values at/);

    const gated = await runInProcess(["deploy", "docker", dir, "--run"], undefined, env);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toMatch(/deploy stopped: FASTAGENT_SECRETS_DIR points this run's values at/);
    expect(gated.stderr).not.toMatch(/Docker CLI not found|Docker daemon/); // refused before any Docker work
  });

  it("deploy docker refuses --run from a generated artifact that drifted from the definition", async () => {
    // Reporting the drift is enough when only producing artifacts. `--run` would deploy FROM it, which is a
    // determinate mismatch between what ships and what the definition says — so it stops before Docker is touched.
    // (writeArtifacts owns WHICH files are stale; this is the dispatcher's wiring of that fact to an exit code.)
    const dir = await agentWorkspace("fa-deploy-stale-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    expect((await runInProcess(["deploy", "docker", dir])).code).toBe(0);
    const compose = join(dir, "fastagent.compose.yml");
    // Keep the marker (it is still ours), change the content: drifted, not disowned.
    await writeFile(compose, `${await readFile(compose, "utf8")}# drifted\n`);

    const release = join(dir, ".fastagent/deploy", "fastagent.release.json");
    const before = await readFile(release, "utf8");

    const gated = await runInProcess(["deploy", "docker", dir, "--run"]);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toMatch(/deploy stopped: fastagent\.compose\.yml no longer match/);
    expect(gated.stderr).not.toMatch(/Docker CLI not found|Docker daemon/); // refused before any Docker work
    // Refused before anything is on disk: the release manifest is rewritten unconditionally, so deciding after the
    // writes would leave a release id that was never deployed, and print `wrote …` lines above `deploy stopped`.
    expect(await readFile(release, "utf8")).toBe(before);
    expect(gated.stderr).not.toMatch(/wrote /);
  });

  it("deploy has no --tunnel: public ingress is the operator's, named as http.publicUrl", async () => {
    const dir = await agentWorkspace("fa-deploy-no-tunnel-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const result = await runInProcess(["deploy", "docker", dir, "--tunnel"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--tunnel'");
    await expect(access(join(dir, "fastagent.compose.yml"))).rejects.toThrow();
  });
});
