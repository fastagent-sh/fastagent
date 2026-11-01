/**
 * A CLEAN MACHINE for every test file: an empty HOME, so the machine's credentials (`~/.fastagent/.secrets/auth.json`,
 * the global layer an agent's own file falls back to) never reach a test. A test about that layer stubs HOME with
 * contents of its own.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "fa-test-home-"));

// No model list is fetched from pi.dev (catalog.ts): a test that is about the refresh serves its own catalog.
process.env.FASTAGENT_OFFLINE = "1";

// The CLI subprocess tests each cold-start the whole import graph; V8's on-disk compile cache lets every
// spawn after the first skip recompiling it (children inherit this). Node keys entries by file content and
// Node version, so a stale entry cannot be served.
process.env.NODE_COMPILE_CACHE ??= join(tmpdir(), "fa-test-compile-cache");
