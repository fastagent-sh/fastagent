import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildChatRuntime } from "../src/engines/pi/chat.ts";

// `chat` must run the SAME agent dev/start serve, presented in pi's TUI — NOT pi's vanilla
// discovery. buildChatRuntime is split out precisely so that injection is inspectable without a
// TTY. In-memory sessions keep the test from writing to the machine's pi session store.
describe("chat: buildChatRuntime injects fastagent's assembled agent into pi's session", () => {
  it("uses the definition's prompt + skills + tools and the config model, definition-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-chat-"));
    try {
      await writeFile(join(dir, "AGENTS.md"), "# Test Agent\nMAGIC_CHAT_MARKER_91. Be terse.\n");
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      await mkdir(join(dir, "skills", "greet"), { recursive: true });
      await writeFile(
        join(dir, "skills", "greet", "SKILL.md"),
        "---\nname: greet\ndescription: How to greet a user.\n---\nSay hi warmly.\n",
      );

      const rt = await buildChatRuntime(dir, {}, SessionManager.inMemory());
      try {
        const st = rt.session.agent.state;
        // Default coding tools by NAME (pi rebuilds them) and nothing else — definition-only, no
        // machine-global tools leaked in.
        expect(st.tools.map((t) => t.name)).toEqual(["read", "bash", "edit", "write"]);
        // The injected system prompt is fastagent's assembled prompt: the definition's AGENTS.md
        // content and its skill are present (pi's global AGENTS.md / skills are not).
        const sp = st.systemPrompt ?? "";
        expect(sp).toContain("MAGIC_CHAT_MARKER_91");
        expect(sp).toMatch(/greet/);
        // The config model resolved (fastagent's, not pi's settings default).
        expect(st.model).toBeDefined();
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
