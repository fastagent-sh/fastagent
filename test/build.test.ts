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
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { runInProcess } from "./cli-run.ts";
import { ROOT, made, project, FILES, listing } from "./build-fixtures.ts";

vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"));

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

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

  it("refuses what a dev serve refuses, before writing anything", async () => {
    const dir = project({ "src/tools/bad.ts": "throw new Error('boom at import');\n" });
    await expect(buildProject(dir)).rejects.toThrow("src/tools/bad.ts: boom at import");
    expect(readdirSync(dir)).not.toContain("dist");
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
