/**
 * `fastagent build`: a source project compiled into `dist/`, the package an app or a host opens. Projects sit under
 * test/fixtures so their imports resolve this repository's packages, TypeScript included, as an installed agent's do.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { buildDefinition } from "../src/harnesses/pi-durable/open.ts";
import { runInProcess } from "./cli-run.ts";

const ROOT = join(import.meta.dirname, "fixtures");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = join(ROOT, `.tmp-build-${process.pid}-${made.length}`);
  made.push(dir);
  const all = {
    "package.json": JSON.stringify({
      name: "@acme/support",
      version: "1.2.0",
      description: "Answers support questions.",
      type: "module",
      dependencies: { "@fastagent-sh/fastagent": "^0.29.0", "@earendil-works/pi-durable": "1.5.0", lodash: "^4" },
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const TOOL = `import { readFileSync } from "node:fs";
import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { shout } from "../../lib/shout.ts";
import data from "./lookup/data.json" with { type: "json" };
const note = readFileSync(new URL("./lookup/note.txt", import.meta.url), "utf8").trim();
export default defineTool({
  name: "lookup",
  description: "Look something up.",
  parameters: obj({ text: str() }),
  execute: async ({ text }) => ({ output: [{ type: "text", text: [shout(text), data.unit, note].join(" ") }] }),
});
`;

const FILES: Record<string, string> = {
  "fastagent.config.ts": 'export default { defaults: { model: "openai/gpt-6.1-sol" } };\n',
  "SYSTEM.md": "You are Support.\n",
  "AGENTS.md": "Be brief.\n",
  LICENSE: "MIT\n",
  "context.json": JSON.stringify({ environment: { variables: { LOOKUP_KEY: { description: "the lookup service" } } } }),
  "skills/lookup/SKILL.md": "---\nname: lookup\ndescription: Look up\n---\nUse lookup.\n",
  "skills/lookup/.env": "SKILL_TOKEN=leaked\n",
  "prompts/review.md": "Review $1.\n",
  "lib/shout.ts": "export const shout = (text: string): string => text.toUpperCase();\n",
  "src/tools/lookup.ts": TOOL,
  "src/tools/lookup/data.json": '{ "unit": "kg" }\n',
  "src/tools/lookup/note.txt": "from the note\n",
  "src/tools/lookup.test.ts": "throw new Error('a test is not a module');\n",
  ".secrets/.env": "LOOKUP_KEY=secret\n",
  ".state/agent.sqlite": "state\n",
  "content/repo/README.md": "a clone\n",
};

const listing = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

describe("fastagent build", () => {
  it("writes dist/: the compiled code, its text and resources, and nothing of the machine's", async () => {
    const dir = project(FILES);
    const { dist } = await buildProject(dir);
    expect(listing(dist)).toEqual([
      "AGENTS.md",
      "LICENSE",
      "SYSTEM.md",
      "build.json",
      "context.json",
      "fastagent.config.d.ts",
      "fastagent.config.js",
      "fastagent.schema.json",
      "index.d.ts",
      "index.js",
      "lib/shout.js",
      "package.json",
      "prompts/review.md",
      "skills/lookup/SKILL.md",
      "src/tools/lookup.js",
      "src/tools/lookup/data.json",
      "src/tools/lookup/note.txt",
    ]);
    expect(JSON.parse(readFileSync(join(dist, "package.json"), "utf8"))).toEqual({
      name: "@acme/support",
      version: "1.2.0",
      description: "Answers support questions.",
      type: "module",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./fastagent.schema.json": "./fastagent.schema.json",
      },
      dependencies: { lodash: "^4" },
      peerDependencies: { "@fastagent-sh/fastagent": "^0.29.0", "@earendil-works/pi-durable": "1.5.0" },
    });
  });

  it("exports the definition from the generated entry, its modules running from dist/", async () => {
    const { dist } = await buildProject(project(FILES));
    const built = (await import(join(dist, "index.js"))).default;
    expect(built).toMatchObject({
      format: 1,
      builtWith: expect.any(String),
      name: "@acme/support",
      version: "1.2.0",
      description: "Answers support questions.",
      dir: dist,
    });
    expect(built.inputs.secrets).toEqual([
      { name: "LOOKUP_KEY", description: "the lookup service", optional: false, declaredIn: ["context.json"] },
    ]);
    const [tool] = buildDefinition(built, { LOOKUP_KEY: "k" }).tools;
    const result = await tool?.execute({ text: "hi" }, {} as never, {} as never);
    expect(result?.output).toEqual([{ type: "text", text: "HI kg from the note" }]);
  });

  it("refuses a type error, and emits it anyway with --no-check", async () => {
    const dir = project({ ...FILES, "lib/shout.ts": "export const shout = (text: string): number => text;\n" });
    await expect(buildProject(dir)).rejects.toThrow(/tsc refused the project[\s\S]*lib\/shout\.ts.*TS2322/);
    const { dist } = await buildProject(dir, { check: false });
    expect(listing(dist)).toContain("lib/shout.js");
  });

  it("refuses what a dev serve refuses, before writing anything", async () => {
    const dir = project({ "src/tools/bad.ts": "throw new Error('boom at import');\n" });
    await expect(buildProject(dir)).rejects.toThrow("src/tools/bad.ts: boom at import");
    expect(readdirSync(dir)).not.toContain("dist");
  });

  it("refuses source outside the project, with or without the type check, and writes nothing beside it", async () => {
    const outside = join(ROOT, `.tmp-shared-${process.pid}`);
    made.push(outside);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "shout.ts"), "export const shout = (text: string): string => text;\n");
    const dir = project({
      "src/tools/far.ts": `import { shout } from ${JSON.stringify(join(outside, "shout.ts"))};\nexport default shout;\n`,
    });
    for (const check of [true, false]) {
      await expect(buildProject(dir, { check })).rejects.toThrow(/imports source from outside .*shout\.ts/);
      expect(readdirSync(outside)).toEqual(["shout.ts"]);
      expect(readdirSync(dir)).not.toContain("dist");
    }
  });

  it("builds a project that links a workspace package, whose declarations emit nothing", async () => {
    const shared = join(ROOT, `.tmp-workspace-${process.pid}`);
    made.push(shared);
    mkdirSync(join(shared, "dist"), { recursive: true });
    writeFileSync(
      join(shared, "package.json"),
      JSON.stringify({ name: "@acme/shared", type: "module", exports: { ".": "./dist/index.js" } }),
    );
    writeFileSync(join(shared, "dist/index.js"), "export const unit = 'kg';\n");
    writeFileSync(join(shared, "dist/index.d.ts"), "export declare const unit: string;\n");
    const dir = project({
      ...FILES,
      "src/tools/unit.ts": `import { unit } from "@acme/shared";\nexport default { name: "unit", value: unit };\n`,
    });
    mkdirSync(join(dir, "node_modules/@acme"), { recursive: true });
    symlinkSync(shared, join(dir, "node_modules/@acme/shared"));
    const { dist } = await buildProject(dir);
    expect(listing(dist)).toContain("src/tools/unit.js");
    expect(readdirSync(join(shared, "dist"))).toEqual(["index.d.ts", "index.js"]);
  });

  it("copies a symlinked skill as the files it names, and refuses a link back into what it copies", async () => {
    const shared = join(ROOT, `.tmp-skills-${process.pid}`);
    made.push(shared);
    mkdirSync(join(shared, "review"), { recursive: true });
    writeFileSync(join(shared, "review/SKILL.md"), "---\nname: review\ndescription: Review\n---\nReview.\n");
    const dir = project(FILES);
    symlinkSync(join(shared, "review"), join(dir, "skills/review"));
    const { dist } = await buildProject(dir);
    expect(readFileSync(join(dist, "skills/review/SKILL.md"), "utf8")).toContain("Review.");
    expect(lstatSync(join(dist, "skills/review")).isSymbolicLink()).toBe(false);
    symlinkSync(join(dir, "skills"), join(dir, "skills/loop"));
    await expect(buildProject(dir)).rejects.toThrow(
      /skills\/loop links back to .*skills, a directory this build is copying/,
    );
  });

  it("names the TypeScript it needs when the project's is older", async () => {
    const dir = project(FILES);
    const old = join(dir, "node_modules/typescript");
    mkdirSync(join(old, "bin"), { recursive: true });
    writeFileSync(
      join(old, "package.json"),
      JSON.stringify({ name: "typescript", version: "5.9.2", bin: { tsc: "./bin/tsc" } }),
    );
    await expect(buildProject(dir)).rejects.toThrow(/needs TypeScript 7 or newer; .* has 5\.9\.2/);
  });

  it("leaves the dist/ before it as it was when a build fails", async () => {
    const dir = project(FILES);
    const { dist } = await buildProject(dir);
    const before = listing(dist);
    writeFileSync(join(dir, "lib/shout.ts"), "export const shout = (text: string): number => text;\n");
    await expect(buildProject(dir)).rejects.toThrow(/tsc refused the project/);
    expect(listing(dist)).toEqual(before);
    expect(readdirSync(join(dir, ".fastagent"))).toEqual([]);
  });

  it("refuses syntax a dev serve could not run, as Node's type stripping would", async () => {
    const dir = project({ "src/tools/level.ts": "export enum Level { Low }\nexport default {};\n" });
    await expect(buildProject(dir)).rejects.toThrow(/TS1294/);
  });

  it("warns of a literal credential in the program's mcpServers, which the package publishes", async () => {
    const dir = project({
      "context.json": JSON.stringify({
        mcpServers: {
          docs: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer abc" } },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: an MCP reference, not a JavaScript template
          files: { command: "npx", env: { TOKEN: "${FILES_TOKEN}" } },
        },
      }),
    });
    const { warnings, dist } = await buildProject(dir);
    expect(warnings).toEqual([
      expect.stringContaining("context.json mcpServers.docs.headers.Authorization is a literal"),
    ]);
    // The same advice the deploy gives, which keeps a header's scheme.
    expect(warnings[0]).toContain("a scheme stays");
    expect(listing(dist)).toContain("context.json");
  });

  it("does not copy a .mcp.json: it is the coding tools' file, not the program's", async () => {
    const dir = project({ ".mcp.json": JSON.stringify({ mcpServers: { tooling: { command: "npx" } } }) });
    const { dist } = await buildProject(dir);
    expect(listing(dist)).not.toContain(".mcp.json");
  });

  describe("a stdio command with a path in the program's mcpServers", () => {
    const servers = (command: string) => JSON.stringify({ mcpServers: { local: { command } } });

    it("is shipped when it is under a directory the build copies, with its executable bit", async () => {
      const dir = project({ "context.json": servers("./assets/server"), "assets/server": "#!/bin/sh\n" });
      chmodSync(join(dir, "assets/server"), 0o755);
      const { dist } = await buildProject(dir);
      expect(statSync(join(dist, "assets/server")).mode & 0o111).not.toBe(0);
    });

    it("refuses one the build does not copy, which `dev` runs from the project, and leaves the dist before it", async () => {
      const dir = project({ "context.json": servers("./assets/server"), "assets/server": "#!/bin/sh\n" });
      const { dist } = await buildProject(dir);
      const before = listing(dist);
      writeFileSync(join(dir, "context.json"), servers("./bin/server"));
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "bin/server"), "#!/bin/sh\n");
      await expect(buildProject(dir)).rejects.toThrow(
        /context\.json mcpServers\.local: the command "\.\/bin\/server" is not in dist\/, which holds only what the build copies .*move it under assets\//,
      );
      expect(listing(dist)).toEqual(before);
    });

    it("names a dependency's executable for what it is, not as a file to move under assets/", async () => {
      const dir = project({ "context.json": servers("./node_modules/.bin/mcp-server") });
      mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules/.bin/mcp-server"), "#!/bin/sh\n");
      const refusal = await buildProject(dir).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect(refusal).toMatch(
        /the command "\.\/node_modules\/\.bin\/mcp-server" is in node_modules, which the box installs/,
      );
      expect(refusal).toContain("npx <package>");
      expect(refusal).not.toContain("under assets/");
    });

    it("refuses an mcpServers that cannot be read before dist/ is replaced, and leaves the one before", async () => {
      const dir = project({ "context.json": servers("npx") });
      const { dist } = await buildProject(dir);
      const before = listing(dist);
      writeFileSync(
        join(dir, "context.json"),
        JSON.stringify({ mcpServers: { x: { type: "sse", url: "https://x.test" } } }),
      );
      await expect(buildProject(dir)).rejects.toThrow(/context\.json: invalid MCP configuration/);
      expect(listing(dist)).toEqual(before);
    });

    it("refuses one that is not in the project at all, and one that points out of it", async () => {
      const missing = project({ "context.json": servers("./assets/missing") });
      await expect(buildProject(missing)).rejects.toThrow(
        /the command "\.\/assets\/missing" does not exist in the project/,
      );
      const outside = project({ "context.json": servers("../elsewhere/server") });
      await expect(buildProject(outside)).rejects.toThrow(
        /the command "\.\.\/elsewhere\/server" does not exist in the project/,
      );
    });

    it("leaves a bare command, an absolute path and a variable's directory to the box", async () => {
      for (const command of ["npx", "/opt/mcp/server", "$" + "{MCP_HOME}/server"]) {
        await expect(buildProject(project({ "context.json": servers(command) })), command).resolves.toBeDefined();
      }
    });
  });

  it("packs all of dist/ and no secret file: npm pack holds what the build wrote, none of it a .env", async () => {
    const { dist } = await buildProject(project(FILES));
    const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json"], { cwd: dist });
    const [{ files }] = JSON.parse(stdout) as [{ files: { path: string }[] }];
    const packed = files.map((file) => file.path).sort();
    expect(packed).toEqual(listing(dist));
    expect(packed.filter((file) => /(^|\/)(\.env|\.secrets)/.test(file))).toEqual([]);
  });

  it("is the build command, which prints where dist/ is", async () => {
    const dir = project(FILES);
    const { code, stdout, stderr } = await runInProcess(["build", dir, "--json"]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      dist: join(dir, "dist"),
      name: "@acme/support",
      version: "1.2.0",
      warnings: [],
    });
  });
});
