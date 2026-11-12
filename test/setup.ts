/**
 * A CLEAN MACHINE for every test file, in every tier: an empty HOME, so the machine's credentials
 * (`~/.fastagent/.secrets/auth.json`, the global layer an agent's own file falls back to) never reach a test, and no
 * connection off the machine. A test about that layer stubs HOME with contents of its own.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { forbidNetwork } from "./forbidden.ts";

process.env.HOME = mkdtempSync(join(tmpdir(), "fa-test-home-"));

// No model list is fetched from pi.dev (catalog.ts): a test that is about the refresh serves its own catalog.
process.env.FASTAGENT_OFFLINE = "1";

forbidNetwork();

// vi.waitFor gives up after 1 s unless told otherwise: a bound on how long something took, which load decides as much as
// the code does. A wait that is met returns as soon as it is, so a longer budget costs only a failing test's time.
const WAIT_FOR_MS = 10_000;
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(callback, {
    timeout: WAIT_FOR_MS,
    ...(typeof options === "number" ? { timeout: options } : options),
  })) as typeof vi.waitFor;

// The CLI subprocess tests each cold-start the whole import graph; V8's on-disk compile cache lets every
// spawn after the first skip recompiling it (children inherit this). Node keys entries by file content and
// Node version, so a stale entry cannot be served.
process.env.NODE_COMPILE_CACHE ??= join(tmpdir(), "fa-test-compile-cache");
