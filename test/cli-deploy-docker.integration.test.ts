import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

describe("cli: deploy docker", () => {
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
    const bin = await mkdtemp(join(tmpdir(), "fa-fake-docker-gate-"));
    await writeFile(join(bin, "docker"), `#!/bin/sh\n[ "$1" = compose ] && [ "$2" = version ] && exit 0\nexit 1\n`, {
      mode: 0o755,
    });
    const clean: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
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
