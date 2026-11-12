import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
/**
 * GitHub content against a local stand-in for GitHub (github-standin.ts): a repository is cloned into the instance's
 * working directory, and brought up to date at each start while that loses nothing.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveContent } from "../src/content/resolve.ts";
import { declareContent } from "../src/content/declare.ts";
import { githubRepoOf } from "../src/content/git.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { modelsOver } from "../src/harnesses/models/models.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { assembleAgent, buildDefinition, loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { makeFaux, sentPrompt } from "./faux.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";
import { agent, resolveOne } from "./content-github-fixtures.ts";

afterEach(() => vi.unstubAllEnvs());

describe("github content: resolved, without touching the network or the disk", () => {
  it("is a clone fastagent makes at content/<name> in the working directory", async () => {
    const { agentDir } = await agent();
    const bare = resolveOne(agentDir, { github: "acme/app" });
    expect(bare).toMatchObject({ location: join(agentDir, "content", "app"), kind: "github", repo: "acme/app" });
    expect(bare.notices).toEqual(["not cloned yet: it is cloned when the agent starts"]);
    expect(existsSync(join(agentDir, ".state"))).toBe(false);
    expect(existsSync(join(agentDir, "content"))).toBe(false);
  });
});

describe("github content: what runs the agent clones, what reports on it does not", () => {
  it("the agent is told what it changes in a clone stays, and that a directory is the user's", async () => {
    const { root, agentDir } = await agent();
    const docs = join(root, "docs");
    await mkdir(docs);
    const content = resolveContent(
      [
        ...declareContent(
          { app: { github: "acme/app", ref: "main", description: "The product. Open pull requests against main." } },
          { origin: "program", file: "context.json" },
        ),
        ...declareContent({ docs: { path: docs } }, { origin: "instance", file: "fastagent.json", base: root }),
      ],
      { workdir: agentDir },
    );
    const { faux } = makeFaux();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = sentPrompt(context);
        return fauxAssistantMessage("ok");
      },
    ]);
    const definition = await loadSourceDefinition(agentDir);
    const running = await assembleAgent(definition, {
      storage: new MemoryStorage(),
      runsAs: NOT_HOSTED,
      processEnv: {},
      code: { ...buildDefinition(definition, {}), providers: [faux.provider] },
      config: resolveConfig(definition),
      models: modelsOver(new InMemoryCredentialStore(), [faux.provider]),
      model: "faux/faux-1",
      content,
    });
    await running.messages.send({ sessionId: (await running.sessions.create()).id, content: "hi" }, { wait: 30 });
    await running.close();
    expect(prompt).toContain(
      `- app: ${join(agentDir, "content", "app")} (a shallow clone of github acme/app (declared main) in your own storage: what you change in it stays, and each time you start it is brought up to date where that touches nothing of yours; push to share a change) The product. Open pull requests against main.`,
    );
    expect(prompt).toContain(`- docs: ${docs} (a directory on this machine)`);
  });
});

describe("github content: what a command's <source> adds", () => {
  it("a remote names a GitHub repository in any of the spellings git takes", () => {
    for (const url of [
      "https://github.com/acme/app.git",
      "https://github.com/acme/app",
      "https://token@github.com/acme/app.git",
      "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app.git",
    ]) {
      expect(githubRepoOf(url), url).toBe("acme/app");
    }
    for (const url of ["https://gitlab.com/acme/app.git", "git@github.example.com:acme/app.git", "/srv/app.git"]) {
      expect(githubRepoOf(url), url).toBeUndefined();
    }
  });
});
