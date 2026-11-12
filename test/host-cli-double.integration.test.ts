import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as real from "../src/deploy/runner.ts";
import * as double from "./host-cli-double.ts";

const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
  delete process.env.AWS_PAGER;
  double.resetHostClis();
});

/** The same CLI twice: a script on the PATH for `spawnRunner`, a function for the double. */
const SCRIPT = `#!/bin/sh
input=""
if [ "$1" = read ]; then input=$(cat); fi
printf 'out %s %s|%s|pager[%s]\\n' "$*" "$FOO" "$input" "\${AWS_PAGER-unset}"
printf 'err\\n' >&2
exit "\${CODE:-0}"
`;
const answer = ({ args, input, env }: double.HostCliCall): double.HostCliAnswer => ({
  code: Number(env.CODE ?? 0),
  stdout: `out ${args.join(" ")} ${env.FOO ?? ""}|${args[0] === "read" ? (input ?? "").replace(/\n+$/, "") : ""}|pager[${env.AWS_PAGER ?? "unset"}]\n`,
  stderr: "err\n",
});

it("answers as spawnRunner and awsRunner do: exit code, captured streams, standard input, environment, a CLI not installed", async () => {
  const bin = await mkdtemp(join(tmpdir(), "fa-host-cli-"));
  for (const name of ["cli", "aws"]) {
    await writeFile(join(bin, name), SCRIPT);
    await chmod(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${path}`;
  // The operator's own pager, which `awsRunner` turns off whatever it is.
  process.env.AWS_PAGER = "less";
  for (const name of ["cli", "aws"]) double.hostCli(name, answer);
  const calls = async (module: typeof real | typeof double) => {
    const cli = module.spawnRunner("cli", bin);
    const aws = module.awsRunner(bin);
    return [
      await cli(["list", "--json"], { capture: true, captureStderr: true }),
      await cli(["list"], { capture: true }),
      await cli(["deploy"], {}),
      await cli(["read"], { capture: true, input: "a value\n" }),
      await cli(["fail"], { capture: true, captureStderr: true, env: { FOO: "bar", CODE: "3" } }),
      await aws(["sts", "get-caller-identity"], { capture: true }),
      await module.spawnRunner("fastagent-no-such-cli", bin)(["x"], { capture: true, captureStderr: true }),
    ];
  };
  const fromProcess = await calls(real);
  expect(fromProcess[0]).toEqual({ code: 0, stdout: "out list --json ||pager[less]\n", stderr: "err\n" });
  expect(fromProcess[5]?.stdout).toContain("pager[]");
  expect(fromProcess[6]).toEqual({ code: 127, stdout: "", stderr: "" });
  expect(await calls(double)).toEqual(fromProcess);
});
