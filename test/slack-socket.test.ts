import { afterEach, describe, expect, it, vi } from "vitest";
import { type OpenSlackSocket, type SlackSocketHandlers, connectSlackSocket } from "../src/channels/slack/socket.ts";
import type { SlackEventEnvelope } from "../src/channels/slack/parse.ts";

const API = "https://slack.test/api";
const APP_TOKEN = "xapp-1-A1-1-abc";

interface FakeSocket {
  url: string;
  handlers: SlackSocketHandlers;
  sent: Record<string, unknown>[];
  pings: number;
  closed: boolean;
  /** What Slack says on this connection. */
  say(message: unknown): void;
}

/** Slack's side: `apps.connections.open` answers from a script, and each opened URL is a socket a test drives. */
function slack(opens: ({ ok: true } | { ok: false; error: string } | "unreachable")[] = [{ ok: true }]) {
  const sockets: FakeSocket[] = [];
  const asked: { url: string; authorization: string | null }[] = [];
  const script = [...opens];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      const next = script.length > 1 ? script.shift() : script[0];
      if (next === "unreachable") throw new Error("connect ECONNREFUSED");
      return Response.json(
        next?.ok === false ? next : { ok: true, url: `wss://wss.test/link/?ticket=${asked.length}` },
      );
    }),
  );
  const openSocket: OpenSlackSocket = (url, handlers) => {
    const fake: FakeSocket = {
      url,
      handlers,
      sent: [],
      pings: 0,
      closed: false,
      say: (message) => handlers.message(JSON.stringify(message)),
    };
    sockets.push(fake);
    return {
      send: (data) => {
        if (fake.closed) throw new Error("not open");
        fake.sent.push(JSON.parse(data));
      },
      close: () => {
        fake.closed = true;
      },
      ping: () => {
        fake.pings++;
      },
    };
  };
  return { sockets, asked, openSocket };
}

const FAST = { retryFirstMs: 1, retryCapMs: 2, helloMs: 2_000, pingEveryMs: 1_000_000, pongWithinMs: 1_000_000 };
const hello = { type: "hello", connection_info: { app_id: "A1" } };
const eventsApi = (id: string, text = "hi"): Record<string, unknown> => ({
  envelope_id: id,
  type: "events_api",
  accepts_response_payload: false,
  payload: { type: "event_callback", team_id: "T1", event: { type: "message", channel: "D1", ts: "1.0", text } },
});

const aborts: AbortController[] = [];
function connect(
  fake: ReturnType<typeof slack>,
  ingest: (envelope: SlackEventEnvelope) => Promise<void> = async () => {},
  timing: Parameters<typeof connectSlackSocket>[0]["timing"] = FAST,
) {
  const abort = new AbortController();
  aborts.push(abort);
  const connection = connectSlackSocket(
    { apiBaseUrl: API, appToken: APP_TOKEN, ingest, openSocket: fake.openSocket, timing },
    abort.signal,
  );
  connection.ready.catch(() => {});
  connection.closed.catch(() => {});
  return { connection, abort };
}

/** Wait for the nth socket the connection opened, and say hello on it. */
async function greeted(fake: ReturnType<typeof slack>, index = 0): Promise<FakeSocket> {
  await vi.waitFor(() => expect(fake.sockets.length).toBeGreaterThan(index));
  const socket = fake.sockets[index] as FakeSocket;
  socket.say(hello);
  return socket;
}

afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("slack socket mode: connecting", () => {
  it("opens a connection with the app-level token, and is ready at hello", async () => {
    const fake = slack();
    const { connection } = connect(fake);
    const socket = await greeted(fake);
    await connection.ready;
    expect(fake.asked).toEqual([{ url: `${API}/apps.connections.open`, authorization: `Bearer ${APP_TOKEN}` }]);
    expect(socket.url).toBe("wss://wss.test/link/?ticket=1");
  });
});

describe("slack socket mode: events", () => {
  it("acknowledges an event by its envelope id once it is taken, and not before", async () => {
    const fake = slack();
    const taken = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    const { connection } = connect(fake, async (envelope) => {
      seen.push(envelope);
      await taken.promise;
    });
    const socket = await greeted(fake);
    await connection.ready;
    socket.say(eventsApi("E1", "hello there"));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ type: "event_callback", event: { text: "hello there" } });
    expect(socket.sent).toEqual([]);
    taken.resolve();
    await vi.waitFor(() => expect(socket.sent).toEqual([{ envelope_id: "E1" }]));
  });
});
