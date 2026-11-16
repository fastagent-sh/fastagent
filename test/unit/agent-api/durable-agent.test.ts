import { afterAll } from "vitest";
import { openPostgresStorage } from "../../../packages/fastagent/src/harnesses/pi-durable/postgres/storage.ts";
import { agentApiConformance } from "../../harnesses/agent-api-conformance.ts";
import { durableSubject } from "../../harnesses/durable-subject.ts";
import { type ServedPostgres, servedPostgres } from "../../doubles/postgres-double.ts";

agentApiConformance("pi-durable, in process", durableSubject());

let postgres: Promise<ServedPostgres> | undefined;
const served = (): Promise<ServedPostgres> => {
  postgres ??= servedPostgres();
  return postgres;
};
afterAll(async () => (await postgres)?.close());
// The subject's directory names its instance: a reopen of the directory finds the instance's sessions again.
agentApiConformance(
  "pi-durable on PostgreSQL, in process",
  durableSubject(async (directory) => openPostgresStorage((await served()).url, directory)),
);
// A database that caps transactions and values: most records go in parts, and long calls take several transactions.
agentApiConformance(
  "pi-durable on PostgreSQL that caps transactions and values, in process",
  durableSubject(async (directory) =>
    openPostgresStorage((await served()).url, `capped:${directory}`, {
      limits: { rowsPerTransaction: 600, bytesPerTransaction: 64 * 1024, bytesPerValue: 256 },
    }),
  ),
);
