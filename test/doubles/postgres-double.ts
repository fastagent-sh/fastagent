/**
 * A PostgreSQL server for unit tests: PGlite (PostgreSQL compiled to WebAssembly, in this process) behind a minimal
 * loopback TCP wire-protocol proxy, so the storage reaches it through `pg` and a `postgres://` URL as it reaches a
 * real one. Each extended query (`Parse`..`Sync`) and each transaction (`BEGIN`..`COMMIT`/`ROLLBACK`) runs atomically
 * on one connection at a time, so concurrent `pg.Pool` connections can never interleave unnamed prepared statements or
 * stall the queue. Parity with a real server: `test/integration/double-parity/postgres-double.integration.test.ts`.
 */
import { type AddressInfo, type Socket, createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";

export interface ServedPostgres {
  /** `postgres://…` for a fresh, empty database. */
  url: string;
  close(): Promise<void>;
}

const SSL_REQUEST_CODE = 80877103;
const CANCEL_REQUEST_CODE = 80877102;
const TAG_SIMPLE_QUERY = 0x51; // 'Q'
const TAG_SYNC = 0x53; // 'S'
const TAG_FLUSH = 0x48; // 'H'
const TAG_TERMINATE = 0x58; // 'X'

interface Conn {
  socket: Socket;
  closed: boolean;
}

interface QueuedBatch {
  conn: Conn;
  frames: Buffer[];
}

export async function servedPostgres(): Promise<ServedPostgres> {
  const db = await PGlite.create();
  const sockets = new Set<Socket>();
  const queue: QueuedBatch[] = [];
  let txOwner: Conn | undefined;
  let processing = false;
  let closing = false;
  let activeDrain: Promise<void> = Promise.resolve();

  const nextBatch = (): QueuedBatch | undefined => {
    if (txOwner !== undefined) {
      const idx = queue.findIndex((item) => item.conn === txOwner);
      return idx === -1 ? undefined : queue.splice(idx, 1)[0];
    }
    return queue.shift();
  };

  const drain = (): void => {
    if (processing || closing) return;
    processing = true;
    activeDrain = (async () => {
      try {
        while (!closing) {
          const item = nextBatch();
          if (item === undefined) break;
          if (item.conn.closed) continue;
          try {
            await db.runExclusive(async () => {
              for (const frame of item.frames) {
                if (closing || item.conn.closed) break;
                const response = await db.execProtocolRaw(frame);
                if (response.length > 0 && !item.conn.closed && item.conn.socket.writable) {
                  item.conn.socket.write(Buffer.from(response));
                }
              }
            });
          } catch {
            // A broken protocol exchange rolls back any open transaction so other connections never starve.
            if (!closing) {
              await db.runExclusive(async () => {
                if (db.isInTransaction()) await db.exec("ROLLBACK");
              });
            }
          }
          if (!closing && item.conn.closed && db.isInTransaction()) {
            await db.runExclusive(async () => {
              if (db.isInTransaction()) await db.exec("ROLLBACK");
            });
          }
          txOwner = !closing && !item.conn.closed && db.isInTransaction() ? item.conn : undefined;
        }
      } finally {
        processing = false;
        if (!closing && nextBatch() !== undefined) drain();
      }
    })();
  };

  const releaseConn = (conn: Conn): void => {
    if (conn.closed) return;
    conn.closed = true;
    sockets.delete(conn.socket);
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]?.conn === conn) queue.splice(i, 1);
    }
    if (txOwner === conn && !closing) {
      activeDrain = activeDrain
        .finally(async () => {
          if (closing || txOwner !== conn) return;
          await db.runExclusive(async () => {
            if (db.isInTransaction()) await db.exec("ROLLBACK");
          });
          if (txOwner === conn) txOwner = undefined;
          drain();
        })
        .catch(() => undefined);
    }
  };

  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    sockets.add(socket);
    const conn: Conn = { socket, closed: false };
    let buf: Buffer = Buffer.alloc(0);
    let started = false;
    let pending: Buffer[] = [];

    socket.on("data", (chunk: Buffer) => {
      if (conn.closed || closing) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (buf.length > 0 && !conn.closed) {
        if (!started) {
          if (buf.length < 4) break;
          const len = buf.readInt32BE(0);
          if (len < 4 || buf.length < len) break;
          const frame = Buffer.from(buf.subarray(0, len));
          buf = buf.subarray(len);
          if (len === 8 && frame.readInt32BE(4) === SSL_REQUEST_CODE) {
            socket.write(Buffer.from("N"));
            continue;
          }
          if (len === 16 && frame.readInt32BE(4) === CANCEL_REQUEST_CODE) continue;
          started = true;
          queue.push({ conn, frames: [frame] });
          drain();
          continue;
        }
        if (buf.length < 5) break;
        const tag = buf[0] as number;
        const len = 1 + buf.readInt32BE(1);
        if (len < 5 || buf.length < len) break;
        const frame = Buffer.from(buf.subarray(0, len));
        buf = buf.subarray(len);
        if (tag === TAG_TERMINATE) {
          socket.end();
          releaseConn(conn);
          return;
        }
        if (tag === TAG_SIMPLE_QUERY) {
          queue.push({ conn, frames: [frame] });
          drain();
          continue;
        }
        pending.push(frame);
        if (tag === TAG_SYNC || tag === TAG_FLUSH) {
          queue.push({ conn, frames: pending });
          pending = [];
          drain();
        }
      }
    });
    socket.on("error", () => releaseConn(conn));
    socket.on("close", () => releaseConn(conn));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    close: async () => {
      closing = true;
      queue.length = 0;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await activeDrain.catch(() => undefined);
      await db.close();
    },
  };
}

/** An instance name no other test of this database uses. */
export const freshInstance = (): string => `test-${crypto.randomUUID()}`;
