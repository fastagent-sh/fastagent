/**
 * Reading back the one line the forwarder writes per routine fire.
 *
 * Here rather than in `src/`: nothing we ship parses this — `fastagent deploy agentcore logs` hands the group
 * to the AWS CLI and prints what comes back. Both readers are tests.
 */
/** What the forwarder said about one routine fire: the container's answer, or a call that never came back. */
export type ForwarderFireLine =
  | { kind: "delivered"; occurrence: string; status: number; body: string }
  | { kind: "failed"; occurrence: string; message: string };

/**
 * Parse ONE CloudWatch message into what the forwarder meant by it, or `undefined` when the line is about
 * something else (an ordinary Lambda `START`/`REPORT`, a webhook, another routine).
 *
 * NOT UNDER `test/live/`, which is excluded from `npm test`: this is string work with no AWS in it, and the
 * defect it was extracted over was found by paying for a deployment. `$` is end-of-input in JavaScript, unlike
 * Perl and Python, so an anchored pattern matched nothing real — every CloudWatch message carries a trailing
 * newline, and a timestamp and request id in front. Nothing here is anchored at either end.
 *
 * The head is matched as a LITERAL because that is what the reader means, and a routine name is a filename:
 * `a.b` is a legal one, and a pattern built from it would claim a line about `aXb`.
 *
 * The FORMAT has one producer (`src/deploy/agentcore/forwarder.js`), and `agentcore-forwarder.test.ts` feeds
 * that producer's own output through this function — so the two cannot drift apart without a red offline test.
 */
export function parseFireLine(message: string, routine: string): ForwarderFireLine | undefined {
  const marker = `routine-fire ${routine} (`;
  const at = message.indexOf(marker);
  if (at === -1) return undefined;
  const afterName = message.slice(at + marker.length);
  const close = afterName.indexOf("): ");
  // PAST THIS POINT THE LINE IS OURS, so nothing below may return `undefined`: the caller reads that as "this
  // line was about something else" and keeps waiting on a fire it already has.
  if (close === -1) {
    throw new Error(`a routine-fire line for "${routine}" has no occurrence: ${message.trim().slice(0, 300)}`);
  }
  const occurrence = afterName.slice(0, close);
  // No `.trim()`: `.` does not cross the newline CloudWatch appends, so one here would only look like a guard.
  const tail = afterName.slice(close + "): ".length);
  const failed = /^invoke failed: (.*)/.exec(tail);
  if (failed) return { kind: "failed", occurrence, message: failed[1] as string };
  const delivered = /^(\d+) (.*)/.exec(tail);
  if (!delivered) {
    throw new Error(`unrecognized routine-fire line for "${routine}": ${message.trim().slice(0, 300)}`);
  }
  return { kind: "delivered", occurrence, status: Number(delivered[1]), body: delivered[2] as string };
}
