import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createPiAgentFromDefinition } from "../src/harnesses/pi/create.ts";
import { makeFaux } from "./faux.ts";

// A schedule's body, a caller of POST /invoke and an external clock all reuse a prompt the definition holds by sending
// `/<template> args` (docs/configuration.md#schedules): pi expands it inside `session.prompt`, which every invoke
// goes through. This pins that the serving path keeps that expansion on.
it("an invoke of /<template> args runs the prompt template from prompts/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-spike-"));
  await mkdir(join(dir, "prompts"));
  await writeFile(join(dir, "prompts", "digest.md"), "---\ndescription: d\n---\nEXPANDED-DIGEST-BODY $1\n");
  const { faux } = makeFaux();
  let seen = "";
  faux.setResponses([
    (context) => {
      seen = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage("ok");
    },
  ]);
  const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
  for await (const _event of agent.invoke({ session: "s" }, { text: "/digest today" })) {
    // drain
  }
  expect(seen).toContain("EXPANDED-DIGEST-BODY today");
});
