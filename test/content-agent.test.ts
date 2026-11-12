import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveContent } from "../src/content/resolve.ts";
import { declareContent } from "../src/content/declare.ts";
import { makeFaux, sentPrompt } from "./faux.ts";
import { askOnce, layout } from "./content-agent-fixtures.ts";

describe("an agent with content", () => {
  it("is told where it is and what it works on; what a project holds stays in the project", async () => {
    const { agentDir, app, handbook } = await layout();
    const content = resolveContent(
      declareContent(
        { app: { path: app }, handbook: { path: handbook, description: "The team's style rules." } },
        { origin: "instance", file: "fastagent.json", base: agentDir },
      ),
      { workdir: agentDir },
    );
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("done");
      },
    ]);
    await askOnce(agentDir, faux.provider, content);

    expect(prompt).toContain(`Your working directory, ${agentDir}, is your own directory`);
    expect(prompt).toContain(
      `You work on:\n- app: ${app} (a directory on this machine)\n- handbook: ${handbook} (a directory on this machine) The team's style rules.`,
    );
    // The definition is the agent's own: its AGENTS.md and skills are in the prompt, and a project's AGENTS.md and
    // skills are files in the project, read when the agent works there.
    expect(prompt).toContain("OWN-AGENTS");
    expect(prompt).toContain("<name>deploy</name>");
    for (const fromContent of ["APP-AGENTS", "HANDBOOK-AGENTS", "Cut a release", "Migrate the app"]) {
      expect(prompt).not.toContain(fromContent);
    }
  });

  it("with none, it is told it works only in its own directory", async () => {
    const { agentDir } = await layout();
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    await askOnce(agentDir, faux.provider);
    expect(prompt).toContain("Nothing else is declared for you: you work only in your own directory.");
    expect(prompt).toContain("OWN-AGENTS"); // its own AGENTS.md is its project context still
  });
});
