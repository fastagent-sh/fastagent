/**
 * A CLEAN MACHINE for every test file: an empty HOME, so the machine's credentials (`~/.fastagent/.secrets/auth.json`,
 * the global layer an agent's own file falls back to) never reach a test. A test about that layer stubs HOME with
 * contents of its own.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "fa-test-home-"));
