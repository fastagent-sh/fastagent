import { afterEach, describe, expect, it, vi } from "vitest";
import { declareEnvironment, declaredVariables } from "../src/environment/declare.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";
import { savedEnv, agentDir } from "./environment-fixtures.ts";

// What this machine's dpkg says is environment.integration.test.ts's: here the machine cannot tell, as one that is not Debian.
vi.mock("../src/environment/apt.ts", async (original) => ({
  ...(await original<typeof import("../src/environment/apt.ts")>()),
  missingAptPackages: () => undefined,
}));

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
});

describe("environment: what context.json may declare", () => {
  it("reads packages, aptPackages and variables; an agent that declares none has no environment", () => {
    expect(declareEnvironment(undefined)).toBeUndefined();
    const environment = {
      packages: { gh: "2", "npm:@biomejs/biome": "latest", "aqua:jqlang/jq": "1.8.1", python: "3.12" },
      aptPackages: ["chromium", "fonts-noto-cjk", "libstdc++6"],
      variables: { GITHUB_TOKEN: { description: "gh's token, with repo scope" }, http_proxy: { description: "x" } },
    };
    expect(declareEnvironment(environment)).toEqual(environment);
    // A variable is declared by name, with what it is for; its value comes from the environment.
    expect(declaredVariables(declareEnvironment(environment))).toEqual([
      { name: "GITHUB_TOKEN", declaredIn: "context.json", description: "gh's token, with repo scope", optional: false },
      { name: "http_proxy", declaredIn: "context.json", description: "x", optional: false },
    ]);
  });

  it("refuses what it does not hold, each by name and with its reason", () => {
    const refused = (environment: unknown) => () => declareEnvironment(environment);
    expect(refused([])).toThrow(`"environment" must be an object`);
    expect(refused({ secrets: {} })).toThrow(
      `environment: unknown key "secrets" (valid keys: packages, aptPackages, variables)`,
    );
    // A string where the description goes reads as a value, which context.json never holds.
    expect(refused({ variables: { GH_HOST: "github.example.com" } })).toThrow(
      `environment: variable "GH_HOST" must be { "description": "what it is for" }: its value goes in the value ` +
        `file (.secrets/.env), the environment a deploy runs in, or the host, never in context.json`,
    );
    expect(refused({ variables: { GH_HOST: { description: "x", value: "y" } } })).toThrow(
      `variable "GH_HOST": unknown key "value" (valid keys: description)`,
    );
    expect(refused({ variables: { GH_HOST: { description: " " } } })).toThrow(`"description" must be a non-empty`);
    // Runbooks print it as a comment line: a line break would end the comment and leave a command to paste.
    expect(refused({ variables: { GH_TOKEN: { description: "gh's token\nfly apps destroy x" } } })).toThrow(
      `variable "GH_TOKEN": "description" must be one line of text, without control characters`,
    );
    expect(refused({ variables: { "MY KEY": { description: "x" } } })).toThrow(`is not an environment variable name`);
    // The deployment sets these itself, and never carries a value file's copy: a declaration could never be met.
    for (const name of [
      "PORT",
      "FASTAGENT_MODEL",
      "FASTAGENT_STATE_DIR",
      "FASTAGENT_THINKING_LEVEL",
      "FASTAGENT_HTTP_API",
      "FASTAGENT_HTTP_PUBLIC_URL",
      "FASTAGENT_INGRESS",
    ]) {
      expect(refused({ variables: { [name]: { description: "x" } } })).toThrow(`is set by the deployment itself`);
    }
    expect(refused({ packages: { "cargo:ripgrep": "14" } })).toThrow(
      `package "cargo:ripgrep" installs with cargo:, which builds from source: a whole Rust toolchain in the image ` +
        `for one binary — write the project's release with github:<owner>/<repo>, or install it in your own ` +
        `Dockerfile`,
    );
    expect(refused({ packages: { "vfox:jdx/vfox-php": "8" } })).toThrow(
      /runs a plugin's code .* the plugin is not pinned/,
    );
    expect(refused({ packages: { "s3:bucket/tool": "1" } })).toThrow(
      /installs with s3:, which FastAgent does not install from/,
    );
    expect(refused({ packages: { "http:tool": "1" } })).toThrow(/needs a URL a version cannot hold/);
    expect(refused({ packages: { "github:o/r[bin=x]": "1" } })).toThrow(/has mise's \[options\]/);
    expect(refused({ packages: { "two words": "1" } })).toThrow(/is not a name from mise's registry/);
    expect(refused({ packages: { gh: "ref:main" } })).toThrow(`version "ref:main" — a version is "latest"`);
    expect(refused({ packages: { gh: "system" } })).toThrow(`version "system"`);
    expect(refused({ packages: { gh: "" } })).toThrow(`the version must be non-empty`);
    expect(refused({ packages: { gh: 2 } })).toThrow(`package "gh": the version must be a string`);
    expect(refused({ aptPackages: ["Chromium"] })).toThrow(`apt package "Chromium" is not a Debian package name`);
    expect(refused({ aptPackages: ["git", "git"] })).toThrow(`apt package "git" is listed twice`);
  });
});

describe("environment: prepared by a process that runs the agent", () => {
  it("requires the variables context.json declares before the agent runs, naming the file", async () => {
    const dir = await agentDir({ variables: { FA_TEST_HOST: { description: "the GitHub host gh talks to" } } });
    const open = async (secrets: Record<string, string>) =>
      openServing(await loadSourceDefinition(dir), {
        secrets,
        env: {},
        ownEnv: process.env,
        runsAs: NOT_HOSTED,
        storage: "memory",
      });
    await expect(open({})).rejects.toThrow(/missing required secrets: FA_TEST_HOST \(context\.json\)/);
    // The process's own environment is not where an instance's values come from.
    process.env.FA_TEST_HOST = "github.example.com";
    await expect(open({})).rejects.toThrow(/missing required secrets: FA_TEST_HOST/);
    await (await open({ FA_TEST_HOST: "github.example.com" })).agent.close();
  });
});
