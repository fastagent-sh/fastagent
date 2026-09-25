/**
 * A CLEAN MACHINE for every test file.
 *
 * An agent inherits the box it runs on — this machine's skills and prompt templates are part of its environment
 * (docs/design/core.md §5). That makes the SUITE machine-dependent unless something pins it: the author who has
 * `~/.pi/agent/prompts/` full of their own workflow commands would otherwise see them turn up in `commands()`
 * assertions, and a test written on an empty laptop would fail on theirs. Measured, not hypothetical — it is how
 * this file came to exist.
 *
 * So each test file gets an empty HOME. A test ABOUT inheritance stubs it with contents of its own
 * (`vi.stubEnv("HOME", …)`), which is then the only place a machine's resources are in play.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "fa-test-home-"));
// HOME IS THE FALLBACK, not the answer: pi's `getAgentDir()` reads `PI_CODING_AGENT_DIR` first, so a developer
// who has it set would run the whole inheritance suite against their own agent directory — the exact failure
// this file exists to prevent, one variable over.
delete process.env.PI_CODING_AGENT_DIR;
// Same for the machine's own models file, which `FASTAGENT_MODELS_PATH` moves out of HOME.
delete process.env.FASTAGENT_MODELS_PATH;
