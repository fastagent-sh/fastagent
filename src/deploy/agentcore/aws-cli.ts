/**
 * ONE AWS CLI invocation, and what its result MEANS.
 *
 * The CLI says everything through an exit code plus prose on a stream the caller must opt into capturing — and
 * the three answers a teardown needs are not separable from the code alone: **it is there**, **it is gone**,
 * **I could not find out**. The third one is not a detail. "Gone" ends the command successfully; "could not
 * find out" must stop it or report a leak, because the resource may well still be running and billing.
 *
 * WHY THIS IS A MODULE and not an expression at each call site: `destroy.ts` had eleven of those call sites,
 * and five review rounds found the same defect at a new one each time — a denial read as an absence (three
 * separate rounds, four sites), an empty paginated listing read as broken JSON, and gates that said "see the
 * output above" while the flags they passed had piped that output away. One requirement, N places, every time.
 *
 * So the four decisions that kept being re-derived live here, once:
 *
 * 1. **The stdio flags.** No call site has to know `spawnRunner`'s mapping (`capture`/`captureStderr` true means
 *    pipe, i.e. NOT the terminal). Getting that wrong is what made "see the output above" point at a blank
 *    screen for seven gates.
 * 2. **{@link ABSENT}** — the one description of what "already gone" looks like.
 * 3. **The text travels with the failure.** A caller that cannot reach what AWS said cannot write a message
 *    that omits it; `AccessDeniedException` vs `ThrottlingException` vs `ExpiredToken` are different operator
 *    actions, and that prose is the only thing telling them apart.
 * 4. **What "no results" actually looks like**, which is not what a fake suggested. MEASURED against AWS CLI
 *    2.36.47 (ap-southeast-1, 2026-09-22): an empty bucket answers
 *    `{"RequestCharged": null, "Prefix": ""}`, `scheduler list-schedules` with no match answers
 *    `{"Schedules": []}`, and `describe-log-groups --query` with no match answers `[]`. None of them prints
 *    nothing — so empty stdout is output we could not read, and {@link awsList} says so rather than reporting
 *    an empty list.
 *
 * What is deliberately NOT here: what to DO about each answer. Whether an unreadable read aborts the teardown
 * or degrades it is a per-resource policy (the stack's probe decides the report's honesty; a log-group listing
 * only supplies names), and that belongs at the call site where the reason is visible.
 */
import type { CliRunner } from "../runner.ts";

/** The most of AWS's own words any message carries. */
const SAID_LIMIT = 300;

/** An AWS CLI failure that means the thing is already gone, which is what a teardown is trying to achieve. */
const ABSENT = /does not exist|NotFound|not found|NoSuchBucket|NoSuchEntity|ResourceNotFoundException/i;

/**
 * A read's answer. `unreadable` carries `said` (what AWS printed) and `code`, which only the very first call of
 * a command needs — `127` is "the aws CLI is not installed" rather than anything about the resource.
 */
type AwsRead<T> = { ok: T } | { absent: true } | { unreadable: string; code: number };

/** A write's answer. `absent` is the goal state of a teardown, not a failure. */
type AwsWrite = { done: true } | { absent: true } | { refused: string };

export interface AwsCli {
  /**
   * Run a read and classify it. `parse` turns stdout into the value the caller wanted and returns `undefined`
   * for output it cannot read — which becomes `unreadable`, never a thrown `SyntaxError`: an exception escaping
   * here reaches the operator as a Node stack trace, since `src/cli.ts` has no catch-all.
   */
  read<T>(args: string[], parse: (stdout: string) => T | undefined): Promise<AwsRead<T>>;
  /** A read whose only question is whether the thing is there. */
  present(args: string[]): Promise<AwsRead<true>>;
  write(args: string[]): Promise<AwsWrite>;
}

export function awsCli(aws: CliRunner): AwsCli {
  const read = async <T>(args: string[], parse: (stdout: string) => T | undefined): Promise<AwsRead<T>> => {
    const { code, stdout, stderr } = await aws(args, { capture: true, captureStderr: true });
    // `(no output)` because a message ending in a colon and nothing else tells an operator less than the fact
    // that AWS printed nothing at all — which, given point 4, is itself the anomaly.
    const said = ((stderr ?? "").trim() || stdout.trim()).slice(0, SAID_LIMIT) || "(no output)";
    if (code === 127) {
      return { unreadable: "aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/", code };
    }
    if (code !== 0) return ABSENT.test(stderr ?? "") ? { absent: true } : { unreadable: said, code };
    const parsed = parse(stdout);
    return parsed === undefined ? { unreadable: said, code } : { ok: parsed };
  };
  return {
    read,
    present: (args) => read(args, () => true as const),
    write: async (args) => {
      // NOT captured: a write's output belongs on the terminal, where an operator watching a teardown can see
      // CloudFormation working. Its stderr is captured because a refusal has to be quotable.
      const { code, stderr } = await aws(args, { captureStderr: true });
      if (code === 0) return { done: true };
      if (ABSENT.test(stderr ?? "")) return { absent: true };
      return { refused: (stderr ?? "").trim().slice(0, SAID_LIMIT) };
    },
  };
}

/**
 * A JSON read: `pick` says what it wants out of the parsed document, and this owns the two answers it must not
 * produce.
 *
 * NOT AN EXCEPTION — `JSON.parse` on output the CLI never promised threw
 * `SyntaxError: Unexpected end of JSON input` out of a command whose CLI has no catch-all, i.e. a Node stack
 * trace where one actionable line belonged.
 *
 * AND NOT AN EMPTY LIST. An earlier version returned `[]` for empty stdout, on the claim that the AWS CLI prints
 * nothing for a paginated list with no results. It does not (header, point 4: all three of our list commands
 * print a real document). That claim came from a test double, and acting on it turned output we failed to read
 * into "there is nothing there" — a bucket reported clean because its listing was truncated is the same defect
 * class as a denial read as an absence, reached from the other side. Empty stdout needs no branch of its own:
 * `JSON.parse("")` throws like any other unreadable output, and {@link awsCli} names it `(no output)`.
 *
 * ONE FUNCTION for lists and single values, because they were the same three lines twice — in a module whose
 * whole argument is that a rule with two implementations has none.
 */
export function awsJson<T>(pick: (parsed: unknown) => T | undefined): (stdout: string) => T | undefined {
  return (stdout) => {
    try {
      return pick(JSON.parse(stdout));
    } catch {
      return undefined;
    }
  };
}

/** `logGroups[].logGroupName` as names — the shape both `logs` and `destroy` ask CloudWatch for. */
export const parseLogGroupNames = awsJson<string[]>((parsed) => {
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) throw new Error("not a name list");
  return parsed as string[];
});
