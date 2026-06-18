import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildChatRuntime } from "../src/engines/pi/chat.ts";

// `chat` must run the SAME agent dev/start serve, presented in pi's TUI — NOT pi's vanilla
// discovery. buildChatRuntime is split out precisely so that injection is inspectable without a
// TTY. In-memory sessions keep the test from writing to the machine's pi session store. A raw
// AgentTool via `config.tools` lets the custom-tool path be tested without installing the package.
describe("chat: buildChatRuntime injects fastagent's assembled agent into pi's session", () => {
  it("injects the definition's prompt + skills, the config model, custom tools, definition-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-chat-"));
    try {
      await writeFile(join(dir, "AGENTS.md"), "# Test Agent\nMAGIC_CHAT_MARKER_91. Be terse.\n");
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default {
           model: "openai-codex/gpt-5.5",
           tools: [{
             name: "ping",
             description: "Reply pong.",
             parameters: { type: "object", properties: {} },
             execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
           }],
         };\n`,
      );
      await mkdir(join(dir, "skills", "greet"), { recursive: true });
      await writeFile(
        join(dir, "skills", "greet", "SKILL.md"),
        "---\nname: greet\ndescription: How to greet a user.\n---\nSay hi warmly.\n",
      );

      const rt = await buildChatRuntime(dir, {}, SessionManager.inMemory());
      try {
        const st = rt.session.agent.state;
        // Default coding tools (rebuilt by pi from names) PLUS the config's custom tool, registered
        // through the session factory — definition-only, nothing machine-global leaked in.
        expect(st.tools.map((t) => t.name).sort()).toEqual(["bash", "edit", "ping", "read", "write"]);
        // The injected system prompt is fastagent's: the definition's AGENTS.md and skill are in it.
        const sp = st.systemPrompt ?? "";
        expect(sp).toContain("MAGIC_CHAT_MARKER_91");
        expect(sp).toMatch(/greet/);
        expect(st.model).toBeDefined(); // the config model resolved (fastagent's, not pi's default)
        // Duplication guard: pi appends the skill section + env (date/cwd); the override must carry
        // only base+instructions, or chat drifts from served and wastes context.
        expect((sp.match(/Current date/g) ?? []).length).toBe(1);
        expect((sp.match(/Current working directory/g) ?? []).length).toBe(1);
        expect((sp.match(/<available_skills>/g) ?? []).length).toBe(1);

        // Chat is a coherent startup snapshot per cwd: same-cwd rebuilds (/new, fork) must not
        // half-refresh only the fs-read pieces while config/tools stay stale in Node's import cache.
        await writeFile(join(dir, "AGENTS.md"), "# Changed Agent\nSHOULD_NOT_HOT_RELOAD_IN_CHAT.\n");

        // P1 regression guard: the TUI rebuilds the session on /new (and /resume, fork) via the same
        // factory. The custom tool must come back — registering through customTools (not patching
        // state afterward) is what makes that hold.
        await rt.newSession();
        expect(rt.session.agent.state.tools.map((t) => t.name)).toContain("ping");
        const rebuiltPrompt = rt.session.agent.state.systemPrompt ?? "";
        expect(rebuiltPrompt).toContain("MAGIC_CHAT_MARKER_91");
        expect(rebuiltPrompt).not.toContain("SHOULD_NOT_HOT_RELOAD_IN_CHAT");
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects cross-workspace session switches because chat env is workspace-scoped", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-chat-scope-"));
    const dir = join(root, "agent-a");
    const other = join(root, "agent-b");
    const sessionsDir = join(root, "sessions");
    try {
      await mkdir(dir, { recursive: true });
      await mkdir(other, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "# Agent A\n");
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      await writeFile(join(other, "AGENTS.md"), "# Agent B\n");
      await writeFile(join(other, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      const imported = join(root, "other-session.jsonl");
      await writeFile(
        imported,
        `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: new Date().toISOString(), cwd: other })}\n`,
      );

      const rt = await buildChatRuntime(dir, {}, SessionManager.create(dir, sessionsDir));
      try {
        let invalidated = false;
        rt.setBeforeSessionInvalidate(() => {
          invalidated = true;
        });
        await expect(rt.importFromJsonl(imported, other)).rejects.toThrow(/fastagent chat is workspace-scoped/);
        expect(invalidated).toBe(false);
        expect(rt.cwd).toBe(dir);
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
