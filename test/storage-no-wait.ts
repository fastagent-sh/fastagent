/**
 * `src/harnesses/pi-durable/storage.ts` without the wait for a database another opener holds: refused at once, for a unit
 * test of who refuses and what it says. Installed with
 * `vi.mock("../src/harnesses/pi-durable/storage.ts", () => import("./storage-no-wait.ts"))`.
 */
import { vi } from "vitest";

type Storage = typeof import("../src/harnesses/pi-durable/storage.ts");
const real = await vi.importActual<Storage>("../src/harnesses/pi-durable/storage.ts");

export const openLockedStorage: Storage["openLockedStorage"] = (path, locking, holders) =>
  real.openLockedStorage(path, locking, holders, 0);
