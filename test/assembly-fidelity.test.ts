/**
 * ONE definition, two consumption shapes: the served `Agent` (dev/start/invoke) and chat's resident
 * `AgentSessionRuntime`. They share the front half (`resolveAgentAssembly` — placement, config,
 * model spec, tools, auth) and diverge after it ON PURPOSE: serving re-reads the definition per
 * invoke and assembles the whole prompt itself, chat takes a startup snapshot and lets pi append
 * skills and env. That divergence is the design; what must NOT diverge is what the definition SAYS.
 *
 * This file is the check on that. It exists because the divergence has bitten once already — chat
 * authenticated against the machine-global `~/.pi` while serving used the project's own credentials
 * (fixed in #255, which unified the front half) — and because the git history says the cost is
 * ongoing rather than historical: of the last 14 commits touching the builder, 13 changed two or
 * more assembly files and 10 changed both `create.ts` and `session-builder.ts`. Every capability
 * added so far has had to be wired into both consumers by hand, with nothing but review catching a
 * miss. A capability wired into serving alone does not fail to compile and does not fail any test
 * that asks about serving; it just quietly is not there in chat.
 *
 * So: assert the SHARED facts here, and leave the deliberate differences alone. When this file goes
 * red, the question to ask is "did I wire the new capability into both?" — not "how do I make the
 * assertion pass".
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";
import { buildAgentSessionRuntime } from "../src/engines/pi/session-builder.ts";

/** A definition that exercises every knob both paths are supposed to honour. */
async function definitionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-fidelity-"));
  await writeFile(join(dir, "persona.md"), "You are terse.\n");
  const piUrl = new URL("../src/pi.ts", import.meta.url).href;
  await writeFile(
    join(dir, "fastagent.config.mjs"),
    `import { defineTool, z } from ${JSON.stringify(piUrl)};
     export default {
       model: "openai-codex/gpt-5.5",
       thinkingLevel: "high",
       tools: [
         defineTool({ name: "echo", description: "echo back", input: z.object({}), execute: async () => "ok" }),
         defineTool({ name: "lazy", description: "deferred one", deferred: true, input: z.object({}), execute: async () => "ok" }),
       ],
     };
`,
  );
  return dir;
}

/** Both assemblies over the same directory. Chat gets an in-memory store; serving gets its default. */
async function bothPaths(dir: string) {
  const served = await createPiAgentFromDir(dir);
  const chat = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
  return { served, chat, dispose: () => chat.session.dispose?.() };
}

describe("assembly fidelity: serving and chat read one definition the same way", () => {
  it("agree on the model, the thinking level, the tool surface, and which tools start inactive", async () => {
    const dir = await definitionDir();
    const { served, chat, dispose } = await bothPaths(dir);
    try {
      // The model spec: config → both. The historical failure mode is one path defaulting while the
      // other honours the config, which reads as "the same agent, answering differently".
      expect(chat.session.model?.id).toBe(served.modelSpec.split("/")[1]);

      // The thinking level: config → both (serving via L2, chat via the resident session).
      expect(chat.session.thinkingLevel).toBe("high");

      // The tool SURFACE: the author's tools plus the coding set, one copy each. Compared as sets —
      // ordering is each path's business, membership is the definition's.
      const chatTools = new Set(chat.session.getAllTools().map((t) => t.name));
      for (const name of [...served.toolNames, ...served.deferredToolNames]) {
        expect(chatTools, `${name} is mounted when serving but missing in chat`).toContain(name);
      }

      // Deferral: a deferred tool is REGISTERED but not initially active. pi's session starts
      // everything active, so chat emulates this — the emulation is what regresses silently.
      expect(served.deferredToolNames).toContain("lazy");
      expect(chat.session.getActiveToolNames()).not.toContain("lazy");
      expect(chatTools).toContain("lazy");

      // And the non-deferred author tool IS active in both.
      expect(served.toolNames).toContain("echo");
      expect(chat.session.getActiveToolNames()).toContain("echo");
    } finally {
      dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("read the same credential store — the divergence that actually shipped once", async () => {
    // chat used to authenticate against the machine-global ~/.pi while serving used the project's
    // own auth.json (#255). The runtime does not expose its authPath, so this asserts the same fact
    // where it is observable: a credential written to the file SERVING resolves is visible to the
    // hub CHAT ends up with.
    const dir = await definitionDir();
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(
      join(dir, ".secrets", "auth.json"),
      `${JSON.stringify({ openai: { type: "api_key", key: "sk-fidelity" } })}\n`,
    );
    const { served, chat, dispose } = await bothPaths(dir);
    try {
      expect(served.authPath).toBe(join(dir, ".secrets", "auth.json"));
      const seenByChat = await chat.session.modelRuntime.listCredentials();
      expect(
        seenByChat.some((c) => c.providerId === "openai" && c.type === "api_key"),
        "chat's model hub does not see the credential serving resolves",
      ).toBe(true);
    } finally {
      dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
