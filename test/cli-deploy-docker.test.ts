import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";

describe("cli: deploy docker", () => {
  it("deploy docker generates app-only Compose and keeps user-owned Dockerfile/Compose on re-run", async () => {
    const dir = await agentWorkspace("fa-deploy-docker-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini" };\n`,
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");

    const first = await run(["deploy", "docker", dir]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(
      "docker compose -f fastagent.compose.yml up -d --build", // one spelling: the generated Compose names the value file itself
    );
    const generatedCompose = await readFile(join(dir, "fastagent.compose.yml"), "utf8");
    expect(generatedCompose).toContain('"127.0.0.1:8787:8787"');
    expect(generatedCompose).not.toContain("cloudflared");

    const customDockerfile = "FROM node:22-slim\nRUN echo custom\n";
    const customCompose = `${generatedCompose}\n# custom ingress belongs to me\n`;
    await writeFile(join(dir, "Dockerfile"), customDockerfile);
    await writeFile(join(dir, "fastagent.compose.yml"), customCompose);

    const second = await run(["deploy", "docker", dir]);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("kept Dockerfile");
    expect(second.stderr).toContain("kept fastagent.compose.yml");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toBe(customDockerfile);
    expect(await readFile(join(dir, "fastagent.compose.yml"), "utf8")).toBe(customCompose);
  });

  it("deploy docker --tunnel keeps an existing app-only topology and prints an actionable runbook", async () => {
    const dir = await agentWorkspace("fa-deploy-kept-no-tunnel-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini" };\n`,
    });
    expect((await run(["deploy", "docker", dir])).code).toBe(0);
    const composePath = join(dir, "fastagent.compose.yml");
    const compose = await readFile(composePath, "utf8");

    const result = await run(["deploy", "docker", dir, "--tunnel"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/--tunnel.*kept fastagent\.compose\.yml.*no "tunnel" service/);
    expect(result.stderr).toMatch(/edit it, delete it and regenerate, or pass --force/);
    expect(result.stdout).not.toContain("logs -f tunnel");
    expect(result.stdout).toContain(
      "docker compose -f fastagent.compose.yml up -d --build", // one spelling: the generated Compose names the value file itself
    );
    expect(await readFile(composePath, "utf8")).toBe(compose);
  });

  it("deploy docker gates --run when FASTAGENT_SECRETS_DIR sends the values away from the committed env_file", async () => {
    // The generated Compose names a FIXED `.secrets/.env`, so a relocated secrets dir means the pre-flight checks
    // one file while the container reads another: every declared value is silently absent. Deterministic, so `--run`
    // refuses before Docker is touched; generating artifacts only warns.
    const dir = await agentWorkspace("fa-deploy-secrets-dir-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini" };\n`,
    });
    const elsewhere = await mkdtemp(join(tmpdir(), "fa-secrets-elsewhere-"));
    const env = { ...process.env, FASTAGENT_SECRETS_DIR: elsewhere };

    const planned = await run(["deploy", "docker", dir], undefined, env);
    expect(planned.code).toBe(0);
    expect(planned.stderr).toMatch(/warn: FASTAGENT_SECRETS_DIR points this run's values at/);

    const gated = await run(["deploy", "docker", dir, "--run"], undefined, env);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toMatch(/deploy stopped: FASTAGENT_SECRETS_DIR points this run's values at/);
    expect(gated.stderr).not.toMatch(/Docker CLI not found|Docker daemon/); // refused before any Docker work
  });

  it("deploy docker refuses --run from a generated artifact that drifted from the definition", async () => {
    // Reporting the drift is enough when only producing artifacts. `--run` would deploy FROM it, which is a
    // determinate mismatch between what ships and what the definition says — so it stops before Docker is touched.
    // (writeArtifacts owns WHICH files are stale; this is the dispatcher's wiring of that fact to an exit code.)
    const dir = await agentWorkspace("fa-deploy-stale-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini" };\n`,
    });
    expect((await run(["deploy", "docker", dir])).code).toBe(0);
    const compose = join(dir, "fastagent.compose.yml");
    // Keep the marker (it is still ours), change the content: drifted, not disowned.
    await writeFile(compose, `${await readFile(compose, "utf8")}# drifted\n`);

    const release = join(dir, "fastagent.release.json");
    const before = await readFile(release, "utf8");

    const gated = await run(["deploy", "docker", dir, "--run"]);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toMatch(/deploy stopped: fastagent\.compose\.yml no longer match/);
    expect(gated.stderr).not.toMatch(/Docker CLI not found|Docker daemon/); // refused before any Docker work
    // Refused before anything is on disk: the release manifest is rewritten unconditionally, so deciding after the
    // writes would leave a release id that was never deployed, and print `wrote …` lines above `deploy stopped`.
    expect(await readFile(release, "utf8")).toBe(before);
    expect(gated.stderr).not.toMatch(/wrote /);
  });

  it("deploy docker --tunnel shapes Compose but does not run Docker without --run", async () => {
    const dir = await agentWorkspace("fa-deploy-tunnel-", {
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini" };\n`,
    });
    const result = await run(["deploy", "docker", dir, "--tunnel"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Quick Tunnel");
    const compose = await readFile(join(dir, "fastagent.compose.yml"), "utf8");
    expect(compose).toContain("cloudflare/cloudflared:");
    expect(compose).toContain("http://agent:8787");
    expect(result.stderr).not.toMatch(/Docker CLI not found|Docker daemon/);

    // The file is now authoritative: a later plain generation/run must not treat omitted --tunnel as
    // "remove tunnel" (only --force resets generated topology).
    const second = await run(["deploy", "docker", dir]);
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("fastagent.compose.yml — it no longer matches");
    expect(await readFile(join(dir, "fastagent.compose.yml"), "utf8")).toBe(compose);
  });
});
