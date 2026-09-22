/**
 * The four decisions {@link awsCli} took away from its call sites.
 *
 * They are tested HERE rather than through `destroy.ts` because that is what the module is for: eleven call
 * sites each re-deriving them produced the same defect five review rounds running. A rule with one enforcer can
 * be proven once; a rule with eleven has no enforcer at all.
 */
import { describe, expect, it } from "vitest";
import { awsCli, awsList } from "../src/deploy/agentcore/aws-cli.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

/** Records the options each invocation was given — the flags are half of what this module owns. */
function fake(reply: { code: number; stdout?: string; stderr?: string }) {
  const opts: (Parameters<CliRunner>[1] | undefined)[] = [];
  const runner: CliRunner = async (_args, options) => {
    opts.push(options);
    return { code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { cli: awsCli(runner), opts };
}

const ident = (stdout: string) => stdout;

describe("awsCli", () => {
  it("separates gone from could-not-find-out, which no exit code does", async () => {
    // The distinction the whole teardown rests on: `absent` ends a destroy successfully, `unreadable` must not.
    // Reading a denial as an absence is how `destroy` came to report "nothing left to delete" over a Bedrock
    // runtime that was still billing — three review rounds, four call sites, one rule.
    const gone = await fake({ code: 254, stderr: "Stack with id fastagent-x does not exist" }).cli.present(["x"]);
    expect(gone).toEqual({ absent: true });

    for (const stderr of [
      "An error occurred (AccessDeniedException) when calling the operation",
      "An error occurred (ThrottlingException): Rate exceeded",
      "An error occurred (ExpiredTokenException): The security token included in the request is expired",
    ]) {
      const denied = await fake({ code: 254, stderr }).cli.present(["x"]);
      expect(denied, stderr).toMatchObject({ unreadable: expect.stringContaining("Exception") });
    }
  });

  it("carries what AWS said, because a caller that cannot reach it writes a message without it", async () => {
    // Seven gates in `destroy.ts` said "see the output above" while the flags below piped that output away.
    // The prose is the only thing separating one operator action from another, so a failure cannot lose it.
    const { cli } = fake({ code: 254, stderr: "AccessDeniedException: not authorized to DeleteLogGroup" });
    const read = await cli.present(["x"]);
    expect(read).toMatchObject({ unreadable: "AccessDeniedException: not authorized to DeleteLogGroup" });
    expect(await cli.write(["x"])).toEqual({ refused: "AccessDeniedException: not authorized to DeleteLogGroup" });
  });

  it("captures BOTH streams on a read, so nothing about an expected absence reaches the terminal", async () => {
    // `spawnRunner` maps capture => pipe, and knowing that is not a call site's job: an inventory of an
    // already-deleted deployment would otherwise print three AWS errors and look like three failures.
    const { cli, opts } = fake({ code: 0, stdout: "{}" });
    await cli.present(["x"]);
    expect(opts[0]).toEqual({ capture: true, captureStderr: true });

    // A WRITE does not capture stdout: an operator watching a teardown should see CloudFormation working.
    await cli.write(["y"]);
    expect(opts[1]).toEqual({ captureStderr: true });
  });

  it("reads what AWS really answers for 'no results', and calls empty stdout unreadable", async () => {
    // MEASURED (AWS CLI 2.36.47, ap-southeast-1, 2026-09-22), because a fake said otherwise and a defensive
    // branch got built on it: an empty bucket answers `{"RequestCharged": null, "Prefix": ""}`,
    // `scheduler list-schedules` answers `{"Schedules": []}`, `describe-log-groups --query` answers `[]`.
    for (const stdout of ['{"RequestCharged": null, "Prefix": ""}', '{"Schedules": []}', "[]"]) {
      const { cli } = fake({ code: 0, stdout });
      expect(
        await cli.read(
          ["x"],
          awsList<string>(() => []),
        ),
        stdout,
      ).toEqual({ ok: [] });
    }

    // So empty stdout is NOT "no results" — it is output we failed to read, and answering "there is nothing
    // there" is how a truncated listing gets reported as a clean resource. It needs no branch of its own
    // (`JSON.parse("")` throws like anything else unreadable), but it does need to SAY so: a gate ending in a
    // colon and nothing after it tells an operator less than "AWS printed nothing".
    const { cli } = fake({ code: 0, stdout: "" });
    expect(
      await cli.read(
        ["x"],
        awsList<string>(() => ["never"]),
      ),
    ).toMatchObject({ unreadable: "(no output)" });
  });

  it("output the parser rejects is unreadable, never a thrown SyntaxError", async () => {
    // `JSON.parse` on output the CLI never promised threw out of a command whose CLI has no catch-all, so the
    // operator got a Node stack trace where one actionable line belonged.
    const { cli } = fake({ code: 0, stdout: "<html>proxy error</html>" });
    expect(
      await cli.read(
        ["x"],
        awsList<string>(() => []),
      ),
    ).toMatchObject({
      unreadable: "<html>proxy error</html>",
    });
  });

  it("a missing CLI is its own answer, since it says nothing about the resource", async () => {
    const { cli } = fake({ code: 127 });
    const read = await cli.read(["x"], ident);
    expect(read).toMatchObject({ code: 127, unreadable: expect.stringContaining("aws CLI not found") });
  });

  it("a write that succeeded is done, and one whose target was already gone is the goal state", async () => {
    expect(await fake({ code: 0 }).cli.write(["x"])).toEqual({ done: true });
    expect(await fake({ code: 254, stderr: "ResourceNotFoundException" }).cli.write(["x"])).toEqual({ absent: true });
  });

  it("caps how much of AWS's output a message carries", async () => {
    const { cli } = fake({ code: 254, stderr: "x".repeat(900) });
    const read = await cli.present(["x"]);
    expect("unreadable" in read && read.unreadable.length).toBe(300);
  });
});
