import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";

describe("cli: routine and tool", () => {
  it("run on an unknown routine name exits 1 and lists the available routines", async () => {
    const routineHref = new URL("../src/schedule/routine.ts", import.meta.url).href;
    const dir = await agentWorkspace("fa-fire-", {
      "routines/daily.ts": `import { defineRoutine } from ${JSON.stringify(routineHref)};\nexport default defineRoutine({ cron: "0 9 * * *", prompt: "digest" });\n`,
    });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL; // unknown-name exits before any model resolution
    const { code, stderr } = await run(["routine", "run", "nope", dir], undefined, env);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown routine "nope"/);
    expect(stderr).toMatch(/available: daily/); // found in routines/ — the same set dev/start serve
    // The path is REPORTED from the resolved agent dir.
    expect(stderr).toContain(`looked in ${join(dir, "routines")}`);
  });

  it("routine list reads BOTH owners: the declared routines and the agent's own pending wake-ups", async () => {
    // Cancelling a wake-up is the agent's (`unwake`), and that command is gone on purpose. Reading one is
    // not: without this, finding out why an agent wakes at 3am means opening
    // `<stateRoot>/schedule/wakeups.json` by hand.
    const dir = await agentWorkspace("fa-list-", {
      "routines/daily.mjs": `export default { cron: "0 9 * * *", prompt: "go" };\n`,
      "routines/reindex.mjs": `export default { prompt: "refresh" };\n`,
    });
    const { addWakeup } = await import("../src/schedule/wakeups.ts");
    const { resolveStateRoot } = await import("../src/paths.ts");
    const added = addWakeup(resolveStateRoot(dir), {
      session: "chat:42",
      prompt: "check the deploy",
      fireAt: new Date(Date.now() + 3_600_000),
    });
    if (!added.ok) throw new Error(added.error);

    const text = await run(["routine", "list", dir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/daily\s+\S+\s+cron 0 9 \* \* \*/);
    expect(text.stdout).toMatch(/reindex\s+on demand/); // no cron: the name is the only way in
    expect(text.stdout).toContain(`wake ${added.id}`); // labelled — a different owner, not a routine
    expect(text.stdout).toContain("session=chat:42");

    const asJson = await run(["routine", "list", "--json", dir]);
    const parsed = JSON.parse(asJson.stdout) as { routines: { name: string }[]; wakeups: { id: string }[] };
    expect(parsed.routines.map((r) => r.name)).toEqual(["daily", "reindex"]);
    expect(parsed.wakeups.map((w) => w.id)).toEqual([added.id]);
  });

  it("routine history refuses an impossible name with exit 1, not an empty history", async () => {
    // The difference that matters to a script: a mistyped argument and "this schedule has never fired" must not
    // both look like success with no output — which is exactly what `--json` printing nothing would say.
    const dir = await agentWorkspace("fa-history-");
    const bad = await run(["routine", "history", "../escape", dir, "--json"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/cannot be a routine name/);
    // A real name that simply has no claims is the other case, and it succeeds with an empty history.
    const empty = await run(["routine", "history", "daily", dir, "--json"]);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual([]);

    // Unreadable state is a THIRD case, and it is the operator's to fix: a read-only command says so in one line
    // rather than printing the Node stack `readFires` throws for the serving boot's benefit.
    await mkdir(join(dir, ".state", "schedule", "claims"), { recursive: true });
    await writeFile(join(dir, ".state", "schedule", "claims", "daily"), ""); // a FILE where the dir goes
    const broken = await run(["routine", "history", "daily", dir, "--json"]);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toMatch(/fired-slot claims for "daily" are unreadable/);
    expect(broken.stderr).not.toMatch(/at listClaims/); // no stack
  });

  it("routine history points at the journal it does NOT print, by the sessions dir the serve writes", async () => {
    // The rows say a fire happened; what it SAID is a session record this command never opens. The pointer is the
    // only thing standing in for it, so it has to name the directory a serve actually writes (state root, not the
    // agent dir) and enough of the file name to pick it out of that directory.
    const dir = await agentWorkspace("fa-history-pointer-");
    const claims = join(dir, ".state", "schedule", "claims", "daily");
    await mkdir(claims, { recursive: true });
    await writeFile(join(claims, "2026-01-01T09-00-00-000Z"), JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z" }));

    const { code, stdout, stderr } = await run(["routine", "history", "daily", dir]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/2026-01-01T09:00:00.000Z/);
    expect(stderr).toContain(`session routine:daily`);
    expect(stderr).toContain(join(dir, ".state", "sessions"));
    // pi cannot name a record `routine:daily`, so the id is NOT the file name — the schedule name is what survives
    // the encoding, and it is what the line tells the reader to look for.
    expect(stderr).toMatch(/name carries "daily"/);
  });

  it("an unknown name still reports the file that failed to load — that IS why the name is missing", async () => {
    // A broken file is absent from the available list, so "unknown tool/schedule" is exactly the case
    // where the author needs to hear about the import error rather than doubt their spelling.
    const dir = await agentWorkspace("fa-unknown-broken-", {
      "tools/broken.mjs": `throw new Error("boom at import");\n`,
      "routines/broken.mjs": `throw new Error("sched boom");\n`,
    });
    const tool = await run(["tool", "nope", "{}", dir]);
    expect(tool.code).toBe(1);
    expect(tool.stderr).toMatch(/tools\/broken\.mjs failed to load/);
    expect(tool.stderr).toMatch(/unknown tool "nope"/);

    const fired = await run(["routine", "run", "nope", dir]);
    expect(fired.code).toBe(1);
    expect(fired.stderr).toMatch(/routines\/broken\.mjs failed to load/);
    expect(fired.stderr).toMatch(/unknown routine "nope"/);
  });

  it("run refuses a routine whose declared secret has no value, instead of running a degraded prompt", async () => {
    // `defineRoutine` resolves a prompt builder at load, so an unset value would have produced
    // "Post the digest to " and `fire` would have sent it — the exact failure the declaration exists
    // to prevent. `fire` runs the schedule, so it takes the serving path's assertion.
    const routineHref = new URL("../src/schedule/routine.ts", import.meta.url).href;
    const dir = await agentWorkspace("fa-fire-secret-", {
      "routines/digest.ts":
        `import { defineRoutine } from ${JSON.stringify(routineHref)};\n` +
        `export default defineRoutine({ cron: "0 9 * * *", secrets: ["FA_TEST_FIRE_CHANNEL"],\n` +
        `  prompt: (s) => \`Post the digest to \${s.FA_TEST_FIRE_CHANNEL}\` });\n`,
    });
    const env = { ...process.env };
    delete env.FA_TEST_FIRE_CHANNEL;
    const { code, stderr } = await run(["routine", "run", "digest", dir], undefined, env);
    expect(code).toBe(1);
    expect(stderr).toMatch(/FA_TEST_FIRE_CHANNEL \(routines\/digest\.ts\)/);
    // Through the CLI's failure boundary: the one line that names the file, never a Node stack that
    // buries it (the assertion throws synchronously, so it has no opener promise to ride).
    expect(stderr).toMatch(/^Error: missing required secrets/m);
    expect(stderr).not.toMatch(/at gateSecrets|Node\.js v/);
  });

  it("tool reports the size the MODEL sees, which is not the size it prints", async () => {
    // The printed form is `details`, indented for a human; the model gets the content text (compact JSON). Measuring
    // the piped stdout therefore answers a different question, which is why the run reports this one itself.
    const value = { note: "x".repeat(200) };
    const dir = await agentWorkspace("fa-tool-size-", {
      "tools/big.mjs":
        `export default { name: "big", description: "b", parameters: { type: "object", properties: {} },\n` +
        `  execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(JSON.stringify(value))} }],\n` +
        `    details: ${JSON.stringify(value)} }) };\n`,
    });

    const { code, stdout, stderr } = await run(["tool", "big", "{}", dir]);
    expect(code, stderr).toBe(0);
    const modelChars = JSON.stringify(value).length;
    expect(stderr).toContain(`result: ${modelChars} chars \u2248 ${Math.ceil(modelChars / 4)} tokens to the model`);
    expect(stdout.trim().length).toBeGreaterThan(modelChars); // the indented print is the bigger one
  });

  it("tool asserts only the named tool's secrets, not every mounted tool's", async () => {
    // Same scoping as `fire`: running one tool by hand on a machine that holds only some credentials
    // must not be blocked by a sibling tool's declaration.
    const dir = await agentWorkspace("fa-tool-scope-", {
      "tools/x-post.mjs":
        `export default { name: "x-post", description: "p", parameters: { type: "object", properties: {} },\n` +
        `  secrets: ["FA_TEST_TOOL_KEY"], execute: async () => ({ content: [{ type: "text", text: "x" }] }) };\n`,
      "tools/echo.mjs":
        `export default { name: "echo", description: "e", parameters: { type: "object", properties: {} },\n` +
        `  execute: async () => ({ content: [{ type: "text", text: "echoed" }] }) };\n`,
    });
    const env = { ...process.env };
    delete env.FA_TEST_TOOL_KEY;
    const ok = await run(["tool", "echo", "{}", dir], undefined, env);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("echoed");
    // The declaring tool itself still refuses, naming its file.
    const gated = await run(["tool", "x-post", "{}", dir], undefined, env);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toMatch(/FA_TEST_TOOL_KEY \(tools\/x-post\.mjs\)/);
    expect(gated.stderr).toMatch(/^Error: missing required secrets/m); // the CLI's failure shape, not a stack
    expect(gated.stderr).not.toMatch(/at gateSecrets|Node\.js v/);
  });

  it("fire asserts only the named schedule's secrets, not every sibling's", async () => {
    // One manual trigger must not require the credentials of the SCHEDULES it is not running: a laptop
    // that has no reason to hold the digest channel can still fire `cleanup`. (The agent it then
    // assembles still gates every mounted tool — a fired turn can call any of them.)
    const routineHref = new URL("../src/schedule/routine.ts", import.meta.url).href;
    const dir = await agentWorkspace("fa-fire-sibling-", {
      "routines/digest.ts":
        `import { defineRoutine } from ${JSON.stringify(routineHref)};\n` +
        `export default defineRoutine({ cron: "0 9 * * *", secrets: ["FA_TEST_FIRE_CHANNEL"],\n` +
        `  prompt: (s) => \`Post to \${s.FA_TEST_FIRE_CHANNEL}\` });\n`,
      "routines/cleanup.ts":
        `import { defineRoutine } from ${JSON.stringify(routineHref)};\n` +
        `export default defineRoutine({ cron: "0 3 * * *", prompt: "tidy up" });\n`,
    });
    const env = { ...process.env };
    delete env.FA_TEST_FIRE_CHANNEL;
    const { stderr } = await run(["routine", "run", "cleanup", dir], undefined, env);
    expect(stderr).not.toMatch(/FA_TEST_FIRE_CHANNEL/); // got past the gate (it then needs a model/auth)
  });
});
