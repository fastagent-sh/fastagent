import { mkdtemp, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it } from "vitest";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { NOT_HOSTED } from "../src/serving-command.ts";

it("a storage written by a newer pi-durable is refused saying so, not with a second close's error", async () => {
  // A deployment rolled back past a release that migrated its database (pi-durable 1.4.0 rewrote the task table).
  const path = join(await mkdtemp(join(tmpdir(), "fa-storage-newer-")), "agent.sqlite");
  await (await openLockedStorage(path, "posix")).close(BACKGROUND_CONTEXT);
  const database = new DatabaseSync(path);
  database.exec("UPDATE durable_schema SET version = version + 1");
  database.close();
  await expect(openLockedStorage(path, "posix")).rejects.toThrow(/schema version \d+ is newer than supported/);
});

it("an agent that fails to open lets go of the storage, so the same process can open it once fixed", async () => {
  // An embedder that corrects its configuration retries in the process it runs in, which still holds the lock.
  const dir = await mkdtemp(join(tmpdir(), "fa-storage-retry-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await expect(
    openServing(await loadSourceDefinition(dir), {
      secrets: {},
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      model: "nope/missing",
    }),
  ).rejects.toThrow(/unknown model "nope\/missing"/);
  const opened = await openServing(await loadSourceDefinition(dir), {
    secrets: {},
    env: {},
    ownEnv: process.env,
    runsAs: NOT_HOSTED,
    model: "anthropic/claude-sonnet-4-5",
  });
  await opened.agent.close();
});
