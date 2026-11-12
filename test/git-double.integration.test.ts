import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as real from "../src/git.ts";
import * as double from "./git-double.ts";

const failure = (call: () => unknown) => {
  try {
    return call();
  } catch (error) {
    return [(error as Error).constructor.name, (error as Error).message];
  }
};

it("fails every call as the real module does where git cannot run (an empty PATH)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-no-git-"));
  const outcomes = async (git: typeof real | typeof double) => {
    const { answer, run } = git.gitFor("a test needs it", { PATH: dir });
    const ran = await run(["init"], dir).catch((error: Error) => [error.constructor.name, error.message]);
    return { answered: failure(() => answer(["rev-parse", "--is-inside-work-tree"], dir)), ran };
  };
  const expected = ["GitNotInstalled", "git is not installed: a test needs it"];
  expect(await outcomes(real)).toEqual({ answered: expected, ran: expected });
  expect(await outcomes(double)).toEqual(await outcomes(real));
});

it("answers what a test scripts as real git answers it in a checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-git-checkout-"));
  await writeFile(join(dir, ".gitignore"), ".env\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // What channels-setup.test.ts scripts for a value file git would track, and for one it ignores.
  const answers = {
    "rev-parse --is-inside-work-tree": "true",
    "check-ignore -q prod.env": undefined,
    "check-ignore -q .env": "",
  };
  const { answer } = real.gitFor("a test needs it");
  for (const [line, expected] of Object.entries(answers)) expect(answer(line.split(" "), dir), line).toBe(expected);
  double.gitAnswersIn(dir, answers);
  expect(failure(() => double.gitFor("a test needs it").answer(["status"], dir))).toEqual([
    "Error",
    `git-double: no answer for \`git status\` in ${dir}`,
  ]);
});
