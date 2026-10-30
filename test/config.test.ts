import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GLOBAL_AUTH_PATH, resolveAuthLayers, resolveAuthPath } from "../src/harnesses/models/credentials.ts";
import { modelEnvironment } from "../src/harnesses/models/environment.ts";
import { probeAuthSource } from "../src/harnesses/models/models.ts";
import { modelSpecFor } from "../src/harnesses/pi-durable/open.ts";
import { resolveSecretsDir, resolveStateRoot } from "../src/paths.ts";

describe("config: resolveStateRoot / resolveSecretsDir (the machinery dirs)", () => {
  it("env overrides; default is the absolute in-tree .state; ~ expands", async () => {
    const env = { FASTAGENT_STATE_DIR: "/data" } as NodeJS.ProcessEnv;
    expect(resolveStateRoot("/app", env)).toBe("/data"); // env wins
    expect(resolveStateRoot("relative/dir", {} as NodeJS.ProcessEnv)).toBe(resolve("relative/dir", ".state")); // absolute default
    const { homedir } = await import("node:os");
    expect(resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "~/state" } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), "state"),
    );
    // A RELATIVE override is an operator knob — anchored on cwd (its sibling knobs' convention), NOT on
    // `dir`; only the default is dir-anchored. So it ignores `dir` and resolves against process.cwd().
    expect(resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "state" } as NodeJS.ProcessEnv)).toBe(resolve("state"));
  });

  it("secrets: FASTAGENT_SECRETS_DIR wins; default is the in-tree .secrets; auth derives from it", () => {
    expect(resolveSecretsDir("/app", {} as NodeJS.ProcessEnv)).toBe("/app/.secrets");
    expect(resolveSecretsDir("/app", { FASTAGENT_SECRETS_DIR: "/data/.secrets" } as NodeJS.ProcessEnv)).toBe(
      "/data/.secrets",
    );
    expect(resolveAuthPath("/app", undefined, { FASTAGENT_SECRETS_DIR: "/data/.secrets" } as NodeJS.ProcessEnv)).toBe(
      "/data/.secrets/auth.json",
    );
  });

  it("the global home carries the same shape, with no special case in the resolvers", async () => {
    // `login` outside any agent hands them `~/.fastagent` directly, so `~/.state` / `~/.secrets` can
    // never be created — not because the resolvers check for $HOME, but because nobody passes it.
    const { homedir } = await import("node:os");
    const global = join(homedir(), ".fastagent");
    expect(resolveStateRoot(global, {} as NodeJS.ProcessEnv)).toBe(join(global, ".state"));
    expect(resolveSecretsDir(global, {} as NodeJS.ProcessEnv)).toBe(join(global, ".secrets"));
  });
});

describe("models: modelEnvironment honors authPath (the project-level credential seam)", () => {
  it("reads a stored credential from the GIVEN file, not the global default or env", async () => {
    // Point modelEnvironment at a path and it must read THAT file. "stored credential" (not the
    // "ANTHROPIC_API_KEY" env label) proves the file at authPath won — so an empty project file
    // genuinely reads as not-configured, which is what the startup auth report keys on.
    const path = join(await mkdtemp(join(tmpdir(), "fa-auth-")), "auth.json");
    await writeFile(path, JSON.stringify({ anthropic: { type: "api_key", key: "sk-test" } }));
    expect(
      await probeAuthSource(
        (await modelEnvironment(undefined, { authPath: path })).models,
        "anthropic/claude-sonnet-4-5",
      ),
    ).toBe("stored credential");
  });
});

describe("config: resolveAuthPath (auth-file precedence)", () => {
  it("precedence: the authPath option > FASTAGENT_AUTH_PATH > the agent default; a given value goes absolute", () => {
    // Asserted through the ONE function commands call, not its internal override step: same coverage,
    // one less export existing only for a test.
    const env = { FASTAGENT_AUTH_PATH: "envauth.json" } as NodeJS.ProcessEnv;
    expect(resolveAuthPath("/app", "flagauth.json", env)).toBe(resolve("flagauth.json")); // flag beats env
    expect(resolveAuthPath("/app", undefined, env)).toBe(resolve("envauth.json")); // env when no flag
    expect(resolveAuthPath("/app", undefined, {} as NodeJS.ProcessEnv)).toBe("/app/.secrets/auth.json"); // neither
    expect(resolveAuthPath("/app", "/abs/auth.json", {} as NodeJS.ProcessEnv)).toBe("/abs/auth.json"); // absolute kept
  });

  it("resolveAuthLayers layers the global store under the DEFAULT path only", () => {
    // "Use this file" is an instruction, so an explicitly named path gets no second layer; the default location is
    // a preference, so it reads the user-global store for providers it does not have.
    const fallback = (authPath: string | undefined, env: Record<string, string>) =>
      resolveAuthLayers("/app", authPath, env as NodeJS.ProcessEnv).fallback;
    expect(fallback(undefined, {})).toBe(GLOBAL_AUTH_PATH);
    expect(fallback("flagauth.json", {})).toBeUndefined();
    expect(fallback(undefined, { FASTAGENT_AUTH_PATH: "env.json" })).toBeUndefined();
    // FASTAGENT_SECRETS_DIR names the file just as explicitly, and is what the Fly/Railway/AgentCore artifacts set:
    // a deployed container reads its mounted credentials, never a second layer under its own $HOME.
    expect(fallback(undefined, { FASTAGENT_SECRETS_DIR: "/data/.secrets" })).toBeUndefined();
  });

  it("resolveAuthPath falls back to the workspace project auth file (not the global default)", () => {
    expect(resolveAuthPath("/app", undefined, {} as NodeJS.ProcessEnv)).toBe("/app/.secrets/auth.json");
    expect(resolveAuthPath("/app", undefined, { FASTAGENT_SECRETS_DIR: "/data/.secrets" } as NodeJS.ProcessEnv)).toBe(
      "/data/.secrets/auth.json",
    );
    expect(resolveAuthPath("/app", "flag-auth.json", {} as NodeJS.ProcessEnv)).toBe(resolve("flag-auth.json"));
  });

  it("expands a leading ~ to the home dir (a .env value never gets the shell's expansion)", async () => {
    const { homedir } = await import("node:os");
    const env = { FASTAGENT_AUTH_PATH: "~/.fastagent/auth.json" } as NodeJS.ProcessEnv;
    // the footgun this guards: a bare resolve("~/x") makes a literal `<cwd>/~` dir and the secret lands there
    expect(resolveAuthPath("/app", undefined, env)).toBe(join(homedir(), ".fastagent", "auth.json"));
    expect(resolveAuthPath("/app", "~", {} as NodeJS.ProcessEnv)).toBe(homedir());
    expect(resolveStateRoot("/app", { FASTAGENT_STATE_DIR: "~/s" } as NodeJS.ProcessEnv)).toBe(join(homedir(), "s"));
  });
});

describe("config: modelSpecFor (precedence flag > env > config)", () => {
  it("flag beats env, env beats config", () => {
    const env = { FASTAGENT_MODEL: "e/m" } as NodeJS.ProcessEnv;
    expect(modelSpecFor({ model: "c/m" }, "f/m", env)).toBe("f/m");
    expect(modelSpecFor({ model: "c/m" }, undefined, env)).toBe("e/m");
    expect(modelSpecFor({ model: "c/m" }, undefined, {} as NodeJS.ProcessEnv)).toBe("c/m");
    expect(modelSpecFor({}, undefined, env)).toBe("e/m");
    expect(modelSpecFor({}, undefined, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("an EMPTY FASTAGENT_MODEL is unset, not a veto over config.model", () => {
    // `export FASTAGENT_MODEL=` in a shell or CI job, and a hand-written compose/env entry interpolating a missing
    // variable, both arrive as "": shadowing config.model there would refuse to start a correctly configured agent.
    const empty = { FASTAGENT_MODEL: "" } as NodeJS.ProcessEnv;
    expect(modelSpecFor({ model: "c/m" }, undefined, empty)).toBe("c/m");
    expect(modelSpecFor({}, undefined, empty)).toBeUndefined();
  });
});
