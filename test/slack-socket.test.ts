import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OpenSlackSocket, type SlackSocketHandlers, connectSlackSocket } from "../src/channels/slack/socket.ts";
import type { SlackEventEnvelope } from "../src/channels/slack/parse.ts";
import { log } from "../src/log.ts";

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

  it("says which app it connected to and what its events depend on, once, at the first hello", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const fake = slack();
    const { connection } = connect(fake);
    const first = await greeted(fake);
    await connection.ready;
    expect(info).toHaveBeenCalledWith(
      "[slack] Socket Mode connected to app A1; events arrive only while Socket Mode is on in the app's settings",
    );
    expect(warn).not.toHaveBeenCalled();
    // A refresh opens a second connection by design: it is not another process, and it is not said again.
    first.say({ type: "disconnect", reason: "refresh_requested" });
    const second = await greeted(fake, 1);
    second.say({ ...hello, num_connections: 2 });
    await vi.waitFor(() => expect(first.closed).toBe(true));
    expect(info.mock.calls.filter(([line]) => String(line).includes("Socket Mode connected"))).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when another connection is open for the app at the start, since Slack splits events between them", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.spyOn(log, "info").mockImplementation(() => {});
    const fake = slack();
    const { connection } = connect(fake);
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    (fake.sockets[0] as FakeSocket).say({ ...hello, num_connections: 2 });
    await connection.ready;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("2 connections are open for this app, and Slack splits its events between them"),
    );
  });

  it("ends with the reason when the token is refused, before it ever connected", async () => {
    const { connection } = connect(slack([{ ok: false, error: "invalid_auth" }]));
    await expect(connection.ready).rejects.toThrow("apps.connections.open failed: invalid_auth");
    await expect(connection.closed).rejects.toThrow("invalid_auth");
  });

  it("does not retry a start it could not make, even for a failure that could pass", async () => {
    const fake = slack([{ ok: false, error: "ratelimited" }]);
    const { connection } = connect(fake);
    await expect(connection.ready).rejects.toThrow("ratelimited");
    expect(fake.asked).toHaveLength(1);
  });

  it("ends when Slack says nothing after the socket opens", async () => {
    const { connection } = connect(slack(), undefined, { ...FAST, helloMs: 30 });
    await expect(connection.ready).rejects.toThrow("no hello from Slack within 0.03s");
  });

  it("an abort while the socket is still opening is a cancellation at once, not a failure after the hello wait", async () => {
    const fake = slack();
    const { connection, abort } = connect(fake, undefined, { ...FAST, helloMs: 60_000 });
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(1));
    abort.abort();
    await expect(connection.ready).resolves.toBeUndefined();
    await expect(connection.closed).resolves.toBeUndefined();
    expect(fake.sockets[0]?.closed).toBe(true);
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

  it("leaves an event it could not take unacknowledged, so Slack sends it again, and says why", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const fake = slack();
    let calls = 0;
    const { connection } = connect(fake, async () => {
      if (++calls === 1) throw new Error("Slack auth.test did not finish inside the Events API ACK budget");
    });
    const socket = await greeted(fake);
    await connection.ready;
    socket.say(eventsApi("E1"));
    socket.say(eventsApi("E2"));
    await vi.waitFor(() => expect(socket.sent).toEqual([{ envelope_id: "E2" }]));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("is not acknowledged and Slack will send it again"));
  });

  it("acknowledges what it does not serve, so Slack does not resend it", async () => {
    const ingest = vi.fn(async () => {});
    const fake = slack();
    const { connection } = connect(fake, ingest);
    const socket = await greeted(fake);
    await connection.ready;
    socket.say({ envelope_id: "S1", type: "slash_commands", payload: { command: "/x" } });
    socket.say({ envelope_id: "I1", type: "interactive", payload: { type: "block_actions" } });
    await vi.waitFor(() => expect(socket.sent).toEqual([{ envelope_id: "S1" }, { envelope_id: "I1" }]));
    expect(ingest).not.toHaveBeenCalled();
  });

  it("ignores a message that is not JSON", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const fake = slack();
    const { connection } = connect(fake);
    const socket = await greeted(fake);
    await connection.ready;
    socket.handlers.message("not json");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not JSON"));
  });

  it("does not fail an event whose connection went while it was taken", async () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const fake = slack();
    const taken = Promise.withResolvers<void>();
    const { connection } = connect(fake, () => taken.promise);
    const socket = await greeted(fake);
    await connection.ready;
    socket.say(eventsApi("E1"));
    socket.closed = true;
    taken.resolve();
    await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(expect.stringContaining("closed connection")));
  });
});

describe("slack socket mode: refresh and loss", () => {
  it("opens the next connection before the old one goes, and takes events on both until then", async () => {
    const fake = slack();
    const { connection } = connect(fake);
    const first = await greeted(fake);
    await connection.ready;
    first.say({ type: "disconnect", reason: "warning" });
    await vi.waitFor(() => expect(fake.sockets).toHaveLength(2));
    expect(first.closed).toBe(false); // still in service while the next one dials
    first.say(eventsApi("E1"));
    await vi.waitFor(() => expect(first.sent).toEqual([{ envelope_id: "E1" }]));
    const second = fake.sockets[1] as FakeSocket;
    second.say(hello);
    await vi.waitFor(() => expect(first.closed).toBe(true));
    second.say(eventsApi("E2"));
    await vi.waitFor(() => expect(second.sent).toEqual([{ envelope_id: "E2" }]));
    expect(fake.asked).toHaveLength(2);
  });

  it("ends with the failure and lets the old connection go when the next one cannot be opened", async () => {
    const fake = slack([{ ok: true }, { ok: false, error: "token_revoked" }]);
    const { connection } = connect(fake);
    const first = await greeted(fake);
    await connection.ready;
    first.say({ type: "disconnect", reason: "warning" });
    await expect(connection.closed).rejects.toThrow("apps.connections.open failed: token_revoked");
    // A channel that has ended takes no more events.
    expect(first.closed).toBe(true);
  });

  it("does not leave a listener on the signal for each connection it has had", async () => {
    const fake = slack();
    const { connection, abort } = connect(fake);
    let socket = await greeted(fake);
    await connection.ready;
    for (let cycle = 1; cycle <= 4; cycle++) {
      socket.say({ type: "disconnect", reason: "refresh_requested" });
      socket = await greeted(fake, cycle);
      await vi.waitFor(() => expect(fake.sockets[cycle - 1]?.closed).toBe(true));
    }
    // Node warns past ten, and a signal lives as long as the connection: refreshes come every few hours.
    expect(getEventListeners(abort.signal, "abort").length).toBeLessThanOrEqual(2);
  });

  it("reconnects when the socket is lost, and stays ready", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    void warn;
    const fake = slack();
    const { connection } = connect(fake);
    const first = await greeted(fake);
    await connection.ready;
    first.handlers.close("closed (1006)");
    const second = await greeted(fake, 1);
    second.say(eventsApi("E1"));
    await vi.waitFor(() => expect(second.sent).toEqual([{ envelope_id: "E1" }]));
  });

  it("retries a failure that can pass once it has been connected, with a growing wait", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const fake = slack([{ ok: true }, "unreachable", { ok: false, error: "ratelimited" }, { ok: true }]);
    const { connection } = connect(fake);
    const first = await greeted(fake);
    await connection.ready;
    first.handlers.close("closed (1006)");
    await greeted(fake, 1);
    expect(fake.asked).toHaveLength(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying in 0.001s"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying in 0.002s"));
  });

  it("ends with its reason when Socket Mode is turned off for the app", async () => {
    const fake = slack();
    const { connection } = connect(fake);
    const socket = await greeted(fake);
    await connection.ready;
    socket.say({ type: "disconnect", reason: "link_disabled" });
    await expect(connection.closed).rejects.toThrow("Socket Mode is turned off for this app (link_disabled)");
  });

  it("ends with its reason when the token is refused after it connected", async () => {
    const fake = slack([{ ok: true }, { ok: false, error: "token_revoked" }]);
    const { connection } = connect(fake);
    const socket = await greeted(fake);
    await connection.ready;
    socket.handlers.close("closed (1006)");
    await expect(connection.closed).rejects.toThrow("apps.connections.open failed: token_revoked");
  });

  it("an abort closes the connection and ends it cleanly", async () => {
    const fake = slack();
    const { connection, abort } = connect(fake);
    const socket = await greeted(fake);
    await connection.ready;
    abort.abort();
    await expect(connection.closed).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
  });
});

describe("slack socket mode: a connection that stops answering", () => {
  const LIVENESS = { ...FAST, pingEveryMs: 5, pongWithinMs: 15 };

  it("pings an idle connection, and keeps one that answers", async () => {
    const fake = slack();
    const { connection } = connect(fake, undefined, { ...LIVENESS, pingEveryMs: 20, pongWithinMs: 2_000 });
    const socket = await greeted(fake);
    await connection.ready;
    await vi.waitFor(() => expect(socket.pings).toBe(1));
    socket.handlers.pong();
    await vi.waitFor(() => expect(socket.pings).toBe(2));
    expect(socket.closed).toBe(false);
  });

  it("drops one whose ping goes unanswered and connects again", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const fake = slack();
    const { connection } = connect(fake, undefined, LIVENESS);
    const first = await greeted(fake);
    await connection.ready;
    await vi.waitFor(() => expect(first.closed).toBe(true));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stopped answering pings"));
    await greeted(fake, 1);
    expect(fake.asked).toHaveLength(2);
  });
});
