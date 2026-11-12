import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { hostLogin } from "../src/cli/commands/deploy/host-login.ts";
import { flyLike } from "./host-login-fixtures.ts";

afterEach(() => vi.restoreAllMocks());

it("nobody gets no sign-in: the deploy stops at the host's own gate", () => {
  expect(hostLogin(flyLike("fly"), { kind: "nobody" }, tmpdir())).toEqual({});
});
