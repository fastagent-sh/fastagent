import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it } from "vitest";
import { holdingInstance } from "../src/harnesses/pi-durable/serve.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { openElsewhere } from "./storage-fixtures.ts";

it("a second process cannot open the storage one process holds, and can once it is closed", async () => {
  // WAL alone lets a second process open and write the file, and both would resume and run the same messages.
  const path = join(await mkdtemp(join(tmpdir(), "fa-storage-")), ".state", "agent.sqlite");
  const held = await openLockedStorage(path, "posix", "the other test");
  expect(await openElsewhere(path)).toMatch(
    /^the storage .*agent\.sqlite is held by another process: the other test is running/,
  );
  await held.close(BACKGROUND_CONTEXT);
  expect(await openElsewhere(path)).toBe("opened");
});

it("holdingInstance keeps the lease until asynchronous state work has finished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-held-state-"));
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const running = holdingInstance(dir, async () => {
    entered.resolve();
    await finish.promise;
  });
  try {
    await entered.promise;
    expect(await openElsewhere(join(dir, "agent.sqlite"))).toContain("held by another process");
  } finally {
    finish.resolve();
    await running;
    await rm(dir, { recursive: true, force: true });
  }
});
