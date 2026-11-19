import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWorkspace, fauxAgent, run } from "../../doubles/cli-run.ts";

describe("cli: process contracts", () => {
  it("--version / -v prints the version to stdout and exits 0 (no parse crash)", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await run(["-v"])).stdout.trim()).toBe(v.stdout.trim());
  });

  it("hands the command to the project's own CLI when it is another installation, args and exit code intact", async () => {
    const project = await mkdtemp(join(tmpdir(), "fa-project-cli-"));
    const installed = join(project, "node_modules", "@fastagent-sh", "fastagent");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({
        name: "@fastagent-sh/fastagent",
        version: "9.9.9",
        type: "module",
        bin: { fastagent: "cli.js" },
        exports: { "./package.json": "./package.json" },
      }),
    );
    await writeFile(
      join(installed, "cli.js"),
      'console.log(`project ${process.argv.slice(2).join(" ")}`); process.exitCode = 3;\n',
    );
    const handed = await run(["info", "--json"], project);
    expect([handed.code, handed.stdout.trim()]).toEqual([3, "project info --json"]);
    const viaChdir = await run(["-C", project, "info", "--json"]);
    expect([viaChdir.code, viaChdir.stdout.trim()]).toEqual([3, "project info --json"]);
    const elsewhere = await run(["--version"], await mkdtemp(join(tmpdir(), "fa-no-project-")));
    expect(elsewhere.stdout.trim()).not.toBe("project --version");
  });

  it("invoke reads piped stdin (omitted message or '-'), and exits 2 with clean stdout when stdin is empty", async () => {
    const empty = await run(["invoke"]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toMatch(/missing message/);
    expect(empty.stdout).toBe("");

    const dir = await fauxAgent("fa-cli-stdin-");
    const piped = await run(["-C", dir, "invoke", "--json"], undefined, undefined, "hello from pipe\n");
    expect(piped.code, piped.stderr).toBe(0);
    expect(piped.stdout).toContain("hello from pipe");
    const dash = await run(["-C", dir, "invoke", "-", "--json"], undefined, undefined, "hello via dash\n");
    expect(dash.code, dash.stderr).toBe(0);
    expect(dash.stdout).toContain("hello via dash");

    const arn = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/demo";
    const acEmpty = await run(["agentcore", "invoke", "--arn", arn], undefined, undefined, "   \n");
    expect([acEmpty.code, acEmpty.stdout]).toEqual([2, ""]);
    expect(acEmpty.stderr).toMatch(/missing message/);
    const acDashEmpty = await run(["agentcore", "invoke", "-", "--arn", arn], undefined, undefined, "   \n");
    expect([acDashEmpty.code, acDashEmpty.stdout]).toEqual([2, ""]);
    expect(acDashEmpty.stderr).toMatch(/missing message/);
  });

  it("invoke surfaces a startup error to stderr, keeps stdout empty, exits non-zero", async () => {
    const cwd = await agentWorkspace("fa-cli-inv-");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL; // no model source → assembly fails before any model call (no auth needed)
    const { code, stdout, stderr } = await run(["-C", cwd, "invoke", "hi"], undefined, env);
    expect(code).toBe(2); // the choice a terminal's picker would have asked for: a usage error
    expect(stderr).toMatch(/missing model/);
    expect(stdout).toBe(""); // a failure never pollutes stdout
  });

  it("a directory that is not an agent fails as a one-line startup error, not a raw stack", async () => {
    // resolvePlacement throws SYNCHRONOUSLY, before any .catch(failStartup) chain exists — without
    // placementOrExit the refusal surfaced as an uncaught stack trace (found in acceptance).
    const dir = await mkdtemp(join(tmpdir(), "fa-not-an-agent-"));
    await writeFile(join(dir, "AGENTS.md"), "# just a project\n"); // context, not a definition
    const { code, stderr } = await run(["-C", dir, "info"]);
    expect(code).toBe(1); // runtime failure, not a crash
    expect(stderr).toMatch(/^Error: .*not a fastagent agent.*fastagent init/); // the one-line failStartup presentation
    expect(stderr).not.toMatch(/\n\s+at /); // no stack frames — this is a user-fixable refusal, not a bug
  });
});
