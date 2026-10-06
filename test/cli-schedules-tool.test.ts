import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";

describe("cli: schedules and tool", () => {
  it("schedules list reads BOTH owners: the declared schedules and the agent's own pending wake-ups", async () => {
    // Cancelling a wake-up is the agent's (`unwake`). Reading one is not: without this, finding out why an agent
    // wakes at 3am means opening `<stateRoot>/schedule/wakeups.json` by hand.
    const dir = await agentWorkspace("fa-list-", {
      "schedules/daily.md": `---\ncron: "0 9 * * *"\n---\ngo\n`,
      "schedules/weekly.md": `---\ncron: "0 9 * * 1"\ntz: Asia/Shanghai\n---\nreview\n`,
    });
    const claims = join(dir, ".state", "schedule", "claims", "daily");
    await mkdir(claims, { recursive: true });
    await writeFile(
      join(claims, "2026-01-01T09-00-00-000Z"),
      JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z", outcome: "failed", ms: 12 }),
    );
    const { addWakeup } = await import("../src/schedule/wakeups.ts");
    const { resolveStateRoot } = await import("../src/paths.ts");
    const added = addWakeup(resolveStateRoot(dir), {
      session: "chat:42",
      prompt: "check the deploy",
      fireAt: new Date(Date.now() + 3_600_000),
    });
    if (!added.ok) throw new Error(added.error);

    const text = await run(["schedules", "list", dir]);
    expect(text.code).toBe(0);
    // When it runs next, how the last run ended, and the conversation its turns continue.
    expect(text.stdout).toMatch(
      /daily\s+next \S+\s+cron 0 9 \* \* \*\s+last 2026-01-01T09:00:00.000Z failed\s+session=schedule:daily/,
    );
    expect(text.stdout).toMatch(/weekly\s+next \S+\s+cron 0 9 \* \* 1 Asia\/Shanghai\s+never run/);
    expect(text.stdout).toContain(`wake ${added.id}`); // labelled — a different owner, not a schedule
    expect(text.stdout).toContain("session=chat:42");

    const asJson = await run(["schedules", "list", "--json", dir]);
    const parsed = JSON.parse(asJson.stdout) as {
      schedules: { name: string; session: string; fires: { outcome?: string }[] }[];
      wakeups: { id: string }[];
    };
    expect(parsed.schedules.map((s) => [s.name, s.session, s.fires.map((f) => f.outcome)])).toEqual([
      ["daily", "schedule:daily", ["failed"]],
      ["weekly", "schedule:weekly", []],
    ]);
    expect(parsed.wakeups.map((w) => w.id)).toEqual([added.id]);
  });

  it("schedules list says which file is not a schedule, and refuses unreadable state in one line", async () => {
    const dir = await agentWorkspace("fa-list-broken-", {
      "schedules/daily.md": `---\ncron: "0 9 * * *"\n---\ngo\n`,
      "schedules/broken.md": "no frontmatter\n",
    });
    const listed = await run(["schedules", "list", dir]);
    expect(listed.code).toBe(0);
    expect(listed.stderr).toMatch(/schedules\/broken\.md failed to load, skipping it — it must start with a "---"/);
    expect(listed.stdout).toMatch(/^daily /m);

    // An OLD claim that cannot be read does not fail the text listing, which reads the newest only; the whole history
    // (`--json`) does say so.
    const claims = join(dir, ".state", "schedule", "claims", "daily");
    await mkdir(join(claims, "2026-01-01T09-00-00-000Z"), { recursive: true }); // a directory where a claim file goes
    await writeFile(
      join(claims, "2026-01-02T09-00-00-000Z"),
      JSON.stringify({ firedAt: "2026-01-02T09:00:00.000Z", outcome: "completed", ms: 5 }),
    );
    const textOnly = await run(["schedules", "list", dir]);
    expect(textOnly.code, textOnly.stderr).toBe(0);
    expect(textOnly.stdout).toMatch(/last 2026-01-02T09:00:00.000Z completed/);
    const history = await run(["schedules", "list", dir, "--json"]);
    expect(history.code).toBe(1);
    expect(history.stderr).toMatch(/the fire history of "daily" is unreadable/);
    await rm(claims, { recursive: true });

    // Unreadable state is the operator's to fix: a read-only command says so in one line rather than printing the
    // Node stack `readFires` throws for the serving boot's benefit.
    await mkdir(join(dir, ".state", "schedule", "claims"), { recursive: true });
    await writeFile(join(dir, ".state", "schedule", "claims", "daily"), ""); // a FILE where the dir goes
    const broken = await run(["schedules", "list", dir, "--json"]);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toMatch(/the fire history of "daily" is unreadable/);
    expect(broken.stderr).not.toMatch(/at listClaims/); // no stack
  });

  it("an unknown tool name still reports the file that failed to load — that IS why the name is missing", async () => {
    const dir = await agentWorkspace("fa-unknown-broken-", {
      "tools/broken.mjs": `throw new Error("boom at import");\n`,
    });
    const tool = await run(["tool", "nope", "{}", dir]);
    expect(tool.code).toBe(1);
    expect(tool.stderr).toMatch(/tools\/broken\.mjs failed to load/);
    expect(tool.stderr).toMatch(/unknown tool "nope"/);
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
    // Running one tool by hand on a machine that holds only some credentials
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
});
