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
 * 4. **Empty output is not a parse failure.** The AWS CLI prints NOTHING for a paginated list with no results,
 *    even with `--output json`, so every parser here is handed `""` as a legitimate empty list.
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
    const said = ((stderr ?? "").trim() || stdout.trim()).slice(0, SAID_LIMIT);
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
