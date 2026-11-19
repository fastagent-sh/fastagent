#!/usr/bin/env node
/** fastagent CLI — the thin entry: the project's own CLI when it has one of its own, else this one. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyChdir } from "./cli/chdir.ts";
import { projectCli } from "./cli/project-cli.ts";

process.argv = applyChdir(process.argv);
const project = projectCli(process.cwd(), fileURLToPath(new URL("..", import.meta.url)));
if (project !== undefined) {
  await import(pathToFileURL(project).href);
} else {
  const { runCli } = await import("./cli/program.ts");
  await runCli(process.argv);
}
