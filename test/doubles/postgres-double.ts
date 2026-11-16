/**
 * A PostgreSQL server for unit tests: PGlite (PostgreSQL compiled to WebAssembly, in this process) behind its wire
 * protocol server on a loopback port, so the storage reaches it through `pg` and a `postgres://` URL as it reaches a real
 * one. It runs one transaction at a time across its connections. Parity with a real server:
 * `test/integration/double-parity/postgres-double.integration.test.ts`.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export interface ServedPostgres {
  /** `postgres://…` for a fresh, empty database. */
  url: string;
  close(): Promise<void>;
}

export async function servedPostgres(): Promise<ServedPostgres> {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0, maxConnections: 64 });
  await server.start();
  const port = Number(server.getServerConn().split(":").at(-1));
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    close: async () => {
      await server.stop();
      await db.close();
    },
  };
}

/** An instance name no other test of this database uses. */
export const freshInstance = (): string => `test-${crypto.randomUUID()}`;
