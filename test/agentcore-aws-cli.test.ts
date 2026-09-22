/**
 * The four decisions {@link awsCli} took away from its call sites.
 *
 * They are tested HERE rather than through `destroy.ts` because that is what the module is for: eleven call
 * sites each re-deriving them produced the same defect five review rounds running. A rule with one enforcer can
 * be proven once; a rule with eleven has no enforcer at all.
 */
import { describe, expect, it } from "vitest";
import { awsCli } from "../src/deploy/agentcore/aws-cli.ts";
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

  it('hands `""` to the parser as an empty list, because that is what a paginated AWS list prints', async () => {
    // Not hypothetical, and it crashed the command: the AWS CLI prints NOTHING for a list with no results,
    // even with `--output json`, and `JSON.parse("")` threw `SyntaxError: Unexpected end of JSON input` out of
    // a CLI with no catch-all — a Node stack trace where one actionable line belonged.
    const { cli } = fake({ code: 0, stdout: "" });
    expect(await cli.read(["x"], (stdout) => (stdout.trim() === "" ? [] : ["never"]))).toEqual({ ok: [] });
  });

  it("output the parser rejects is unreadable, never a thrown error", async () => {
    const { cli } = fake({ code: 0, stdout: "<html>proxy error</html>" });
    expect(await cli.read(["x"], () => undefined)).toMatchObject({ unreadable: "<html>proxy error</html>" });
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
