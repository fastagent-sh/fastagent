/**
 * Slack Socket Mode on Bun, where vitest does not run: CI's Bun job runs this file (`bun test/bun/slack-socket.ts`),
 * against slack-stand-in.ts. What Bun can differ in
 * is its `undici` shim: the WebSocket, and the ping that tells a connection nobody answers on from a quiet one.
 */
import { connectSlackSocket } from "../../src/channels/slack/socket.ts";
import { type Peer, frame, slackStandIn } from "../slack-stand-in.ts";
import { check, finish } from "../bun-check.ts";

if (typeof process.versions.bun !== "string") throw new Error("run this with bun: bun test/bun/slack-socket.ts");

async function until(done: () => boolean, ms = 4000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return done();
}

async function connected(
  options: { answerPings: boolean },
  timing: NonNullable<Parameters<typeof connectSlackSocket>[0]["timing"]>,
) {
  const stand = await slackStandIn(options);
  const abort = new AbortController();
  const ingested: unknown[] = [];
  const connection = connectSlackSocket(
    {
      apiBaseUrl: stand.apiBaseUrl,
      appToken: "xapp-1-A1-1-abc",
      ingest: async (envelope) => {
        ingested.push(envelope);
      },
      timing,
    },
    abort.signal,
  );
  connection.ready.catch(() => {});
  connection.closed.catch(() => {});
  return {
    ...stand,
    connection,
    ingested,
    stop: () => {
      abort.abort();
      stand.close();
    },
  };
}

{
  const slack = await connected({ answerPings: true }, { pingEveryMs: 1_000_000, pongWithinMs: 1_000_000 });
  await slack.connection.ready;
  const [peer] = slack.peers as [Peer];
  const event = { type: "event_callback", event: { type: "message", text: "hi" } };
  peer.say({ envelope_id: "E1", type: "events_api", payload: event });
  check(
    "an event is acknowledged on the wire and ingested",
    (await until(() => peer.texts.length > 0)) && peer.texts[0] === '{"envelope_id":"E1"}',
    JSON.stringify(peer.texts),
  );
  check(
    "the ingested event is the envelope's payload",
    JSON.stringify(slack.ingested) === JSON.stringify([event]),
    JSON.stringify(slack.ingested),
  );
  slack.stop();
}
{
  const slack = await connected({ answerPings: true }, { pingEveryMs: 20, pongWithinMs: 150 });
  await slack.connection.ready;
  const pinged = await until(() => (slack.peers[0]?.pings ?? 0) >= 12);
  check(
    "a connection whose pings are answered is kept, past several windows",
    pinged && slack.peers.length === 1,
    `${slack.peers[0]?.pings} pings, ${slack.peers.length} connections`,
  );
  slack.stop();
}
{
  const slack = await connected({ answerPings: false }, { pingEveryMs: 20, pongWithinMs: 80, retryFirstMs: 5 });
  await slack.connection.ready;
  const again = await until(() => slack.peers.length >= 2);
  check(
    "a connection whose pings are not answered is dropped, and connected again",
    again && slack.peers[0]?.closed === true,
    `${slack.peers.length} connections, first closed: ${slack.peers[0]?.closed}`,
  );
  slack.stop();
}
{
  const slack = await connected(
    { answerPings: true },
    { pingEveryMs: 1_000_000, pongWithinMs: 1_000_000, retryFirstMs: 5 },
  );
  await slack.connection.ready;
  (slack.peers[0] as Peer).socket.end(frame(8, Buffer.from([0x03, 0xe8])));
  check(
    "a socket Slack closes is connected again",
    await until(() => slack.peers.length === 2),
    `${slack.peers.length} connections`,
  );
  slack.stop();
}

finish();
