#!/usr/bin/env node
/**
 * fastagent CLI — the thin entry. Everything (parsing, help, dispatch, exit-code policy) lives in
 * cli/program.ts and is loaded lazily, so `fastagent <cmd>` pays only for the module graph that
 * command actually uses (the command registry lazy-imports each implementation in turn).
 *
 * Process side effects (proxy dispatcher, .env loading, log posture, explicit exits) belong to the
 * command modules under cli/commands/ — this file must stay import-free.
 */
const { runCli } = await import("./cli/program.ts");
await runCli(process.argv);
