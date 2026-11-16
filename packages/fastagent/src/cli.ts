#!/usr/bin/env node
/** fastagent CLI — the thin entry. */
const { runCli } = await import("./cli/program.ts");
await runCli(process.argv);
