import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgent, hasEnded, openAgent } from "../../src/index.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { requireEnv, run } from "./env.ts";

installProxyFetch();

const model = requireEnv("FASTAGENT_LIVE_MODEL", "the model used to work across the bound folders");

it(`live content: ${model} reads a handbook, fixes a project and saves the change in notes`, async () => {
  const root = await mkdtemp(join(tmpdir(), "fa-live-content-"));
  const agentDir = join(root, "agent");
  const project = join(root, "shop-api");
  const handbook = join(root, "Team Handbook 规范");
  const notes = join(root, "notes");
  const codeword = randomUUID();
  const standards = "Amounts are integer cents. Round half up with Math.round, never Math.floor or Math.ceil.\n";
  const release = `The release codeword is ${codeword}.\n`;
  const test = `import { test } from "node:test";
import assert from "node:assert/strict";
import { totalWithTax } from "./src/price.js";
test("rounds half up", () => assert.equal(totalWithTax(1005, 0.1), 1106));
`;

  try {
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(handbook);
    await mkdir(notes);
    await writeFile(join(project, "package.json"), '{ "type": "module" }\n');
    await writeFile(join(project, "README.md"), "Run tests with node --test.\n");
    await writeFile(
      join(project, "src", "price.js"),
      "export function totalWithTax(subtotalCents, rate) { return Math.floor(subtotalCents * (1 + rate)); }\n",
    );
    await writeFile(join(project, "price.test.js"), test);
    await writeFile(join(handbook, "standards.md"), standards);
    await writeFile(join(handbook, "release.md"), release);
    await expect(run(process.execPath, ["--test"], project)).rejects.toThrow();

    await createAgent(agentDir, {
      content: [
        { name: "shop", binding: { path: project, description: "The shop's API code." } },
        { name: "handbook", binding: { path: handbook, description: "The team's standards." } },
        { name: "notes", binding: { path: notes, description: "Where change write-ups go." } },
      ],
    });
    await writeFile(join(agentDir, "SYSTEM.md"), "You are a careful engineering assistant. Be brief.\n");
    const agent = await openAgent(agentDir, { model, stateDir: join(root, "state") });
    try {
      const session = await agent.sessions.create();
      const ask = async (text: string) => {
        const message = await agent.messages.send({ sessionId: session.id, content: text }, { wait: 180 });
        expect(hasEnded(message), JSON.stringify(message)).toBe(true);
        expect(message.status, JSON.stringify(message.error)).toBe("completed");
        return message.answer?.text ?? "";
      };

      expect(await ask("What is the release codeword in our handbook?")).toContain(codeword);
      await ask("The shop-api test fails. Fix totalWithTax following our handbook's standards, then run the tests.");
      expect(await readFile(join(project, "price.test.js"), "utf8")).toBe(test);
      expect(await readFile(join(project, "src", "price.js"), "utf8")).toContain("Math.round");
      await run(process.execPath, ["--test"], project);

      await ask("Save a short summary of the change you just made as change-summary.md, for later reference.");
      const summary = await readFile(join(notes, "change-summary.md"), "utf8");
      expect(summary).toContain("Math.round");
      expect(summary).toContain("totalWithTax");
      expect(await readFile(join(handbook, "standards.md"), "utf8")).toBe(standards);
      expect(await readFile(join(handbook, "release.md"), "utf8")).toBe(release);
    } finally {
      await agent.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
