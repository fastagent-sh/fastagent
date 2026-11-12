import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFileText, parseContextFile } from "../src/content/file.ts";
import {
  declareEnvironment,
  declaredVariables,
  declaresTool,
  missingPythonRuntime,
  parsePackageArgument,
  resolvedBackendRefusal,
  runtimeAdvice,
} from "../src/environment/declare.ts";
import { ensureMise, miseBinary, prepareEnvironment } from "../src/environment/mise.ts";
import { addContent, removeContent, writeEnvironment } from "../src/authoring.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";
import { runInProcess } from "./cli-run.ts";
import { savedEnv, agentDir, fakeMise, fakeNpm } from "./environment-fixtures.ts";

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

  it("is read and written with the rest of context.json, an empty one left out", async () => {
    const path = "/a/context.json";
    expect(() => parseContextFile(`{"environment":{"packages":{"gh":"x y"}}}`, path)).toThrow(
      `${path}: environment: package "gh": the version must be non-empty, without spaces`,
    );
    const written = { packages: { gh: "2" }, variables: { GITHUB_TOKEN: { description: "gh's token" } } };
    const file = parseContextFile(JSON.stringify({ content: {}, environment: written }), path);
    expect(file.environment).toEqual({ ...written, aptPackages: [] });
    expect(JSON.parse(contextFileText(file))).toEqual({ content: {}, environment: written });
    expect(
      JSON.parse(contextFileText({ content: {}, environment: { packages: {}, aptPackages: [], variables: {} } })),
    ).toEqual({ content: {} });
    // The two edits keep each other's part of the file.
    const dir = await agentDir();
    await writeEnvironment(dir, () => ({ packages: { gh: "2" }, aptPackages: ["chromium"], variables: {} }));
    await addContent(dir, { name: "app", entry: { github: "acme/app" }, program: true });
    await writeEnvironment(dir, () => ({ packages: { jq: "latest" }, aptPackages: [], variables: {} }));
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8"))).toEqual({
      content: { app: { github: "acme/app" } },
      environment: { packages: { jq: "latest" } },
    });
  });

  it("every edit of context.json keeps the MCP servers exactly as written, so an edit of one part never drops another", async () => {
    const dir = await agentDir();
    const mcpServers = { docs: { type: "http", url: "https://docs.example.com/mcp" }, local: { command: "./srv" } };
    await writeFile(join(dir, "context.json"), JSON.stringify({ content: {}, mcpServers }));
    const kept = async () => JSON.parse(await readFile(join(dir, "context.json"), "utf8")).mcpServers;
    await writeEnvironment(dir, () => ({ packages: { gh: "2" }, aptPackages: [], variables: {} }));
    expect(await kept()).toEqual(mcpServers);
    await addContent(dir, { name: "app", entry: { github: "acme/app" }, program: true });
    expect(await kept()).toEqual(mcpServers);
    await removeContent(dir, "app");
    expect(await kept()).toEqual(mcpServers);
    expect(parseContextFile(JSON.stringify({ content: {}, mcpServers }), "/a/context.json").mcpServers).toEqual(
      mcpServers,
    );
    expect(() => parseContextFile(`{ "mcpServers": [] }`, "/a/context.json")).toThrow(
      '/a/context.json: "mcpServers" must be an object of servers by name',
    );
  });

  it("refuses a registry name by the backend mise resolves it to, unless that backend is allowed", () => {
    for (const backend of ["aqua:jqlang/jq", "github:cli/cli", "core:python", "pypi:ansible", "packslip:x/y"]) {
      expect(resolvedBackendRefusal("x", backend), backend).toBeUndefined();
    }
    expect(resolvedBackendRefusal("tokei", "cargo:tokei")).toMatch(
      /^package "tokei" resolves to cargo:tokei, which builds from source: .* — write the project's release with github:/,
    );
    expect(resolvedBackendRefusal("php", "vfox:jdx/vfox-php")).toMatch(
      /resolves to vfox:jdx\/vfox-php, which runs a plugin's code/,
    );
    expect(resolvedBackendRefusal("x", "newthing:x")).toMatch(
      /resolves to newthing:x, which FastAgent does not install from/,
    );
  });

  it("names the PyPI packages whose python and uv it leaves to the machine", () => {
    const kinds = new Map([
      ["pypi:markitdown", "pypi"],
      ["ansible", "pypi"],
      ["gh", "aqua"],
    ]);
    const missing = missingPythonRuntime({ "pypi:markitdown": "latest", ansible: "11", gh: "2" }, kinds);
    expect(missing).toEqual({ packages: ["pypi:markitdown", "ansible"], missing: ["python", "uv"] });
    expect(runtimeAdvice(missing!)).toBe(
      "pypi:markitdown, ansible install with python and uv, which the environment does not declare: mise then uses " +
        "this machine's, and the image has none — run `fastagent env add python uv`",
    );
    // A runtime under any backend or owner counts.
    const declared = { "pypi:markitdown": "latest", python: "3.12", "aqua:astral-sh/uv": "latest" };
    expect(missingPythonRuntime(declared, kinds)).toBeUndefined();
    expect(declaresTool(declared, "uv")).toBe(true);
    expect(missingPythonRuntime({ gh: "2" }, kinds)).toBeUndefined();
  });

  it("reads `fastagent env add` arguments", () => {
    expect(parsePackageArgument("gh")).toEqual({ name: "gh", version: "latest" });
    expect(parsePackageArgument("gh@2")).toEqual({ name: "gh", version: "2" });
    expect(parsePackageArgument("npm:@biomejs/biome")).toEqual({ name: "npm:@biomejs/biome", version: "latest" });
    expect(parsePackageArgument("npm:@biomejs/biome@2")).toEqual({ name: "npm:@biomejs/biome", version: "2" });
    expect(parsePackageArgument("apt:chromium")).toEqual({ apt: "chromium" });
  });
});

describe("environment: prepared by a process that runs the agent", () => {
  it("an agent without packages borrows the machine's commands; one with packages and no mise is refused", async () => {
    expect(await prepareEnvironment(await agentDir({ aptPackages: ["chromium"] }), process.env)).toEqual({});
    const dir = await agentDir({ packages: { gh: "2" } });
    expect(miseBinary(dir)).toBeUndefined();
    await expect(prepareEnvironment(dir, process.env)).rejects.toThrow(
      `context.json declares packages, and the agent has no mise installed — run \`fastagent env install\` in ${dir}`,
    );
  });

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

describe("environment: the agent's own mise", () => {
  it("is not added to an agent whose package.json does not list FastAgent: its image could not start", async () => {
    const dir = await agentDir();
    const fakeBin = await fakeNpm(dir);
    process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH}`;
    for (const manifest of [undefined, `{"name":"a"}`]) {
      await rm(join(dir, "package.json"), { force: true });
      if (manifest) await writeFile(join(dir, "package.json"), manifest);
      await expect(ensureMise(dir)).rejects.toThrow(
        `${join(dir, "package.json")} does not list @fastagent-sh/fastagent — the agent's mise is one of its ` +
          "dependencies, and an agent with dependencies runs the FastAgent they list. Add it first: " +
          `\`npm install @fastagent-sh/fastagent\` in ${dir}`,
      );
    }
    await expect(readFile(join(dir, "npm-args"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});

describe("environment: `fastagent env`", () => {
  const cli = (args: string[], cwd: string) => runInProcess(args, cwd);
  const declared = async (dir: string): Promise<unknown> =>
    JSON.parse(await readFile(join(dir, "context.json"), "utf8")).environment;

  it("lists the variables context.json declares, and whether each has a value here, never the value", async () => {
    const dir = await agentDir({
      variables: { FA_TEST_HOST: { description: "the GitHub host" }, FA_TEST_TOKEN: { description: "gh's token" } },
    });
    await mkdir(join(dir, ".secrets"));
    await writeFile(join(dir, ".secrets", ".env"), "FA_TEST_TOKEN=ghp_value\n");
    const list = await cli(["env", "list"], dir);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toBe(
      ["FA_TEST_HOST   not set   the GitHub host", "FA_TEST_TOKEN  set       gh's token", ""].join("\n"),
    );
    expect(list.stderr).toContain(
      `no value here for FA_TEST_HOST: dev and start refuse to run until they have one — set them in ` +
        `${join(dir, ".secrets", ".env")}`,
    );
    expect(`${list.stdout}${list.stderr}`).not.toContain("ghp_value");
    const listed = await cli(["env", "list", "--json"], dir);
    expect(JSON.parse(listed.stdout)).toEqual({
      packages: [],
      apt: [],
      variables: [
        { name: "FA_TEST_HOST", description: "the GitHub host", set: false },
        { name: "FA_TEST_TOKEN", description: "gh's token", set: true },
      ],
    });
    expect(listed.stdout).not.toContain("ghp_value");
  });

  it("refuses to edit a context.json whose content is refused, before anything is installed", async () => {
    const dir = await agentDir();
    await writeFile(join(dir, "context.json"), `{ "content": { "a": { "ref": "x" } } }`);
    const { calls } = await fakeMise(dir);
    const add = await cli(["env", "add", "gh@2"], dir);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain(`content "a" needs "github"`);
    expect(await calls()).toEqual([]);
  });

  it("removes packages, without mise; a package it does not have is named", async () => {
    const dir = await agentDir({ packages: { gh: "2" }, aptPackages: ["chromium"] });
    const { calls } = await fakeMise(dir);
    for (const name of ["jq", "toString"]) {
      const unknown = await cli(["env", "remove", name], dir);
      expect(unknown.code, name).toBe(1);
      expect(unknown.stderr).toContain(`the environment has no package "${name}" (it has: gh, apt:chromium)`);
    }
    const remove = await cli(["env", "remove", "gh", "apt:chromium"], dir);
    expect(remove.code, remove.stderr).toBe(0);
    expect(await declared(dir)).toBeUndefined();
    expect(await calls()).toEqual([]);
  });
});
