import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { takeRefused } from "../../guards/forbidden.ts";

afterEach(() => {
  takeRefused();
});

const node = (script: string) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: process.env });

it("a Node process a test starts refuses a connection off the machine, and the test hears of it", () => {
  const child = node(`import net from "node:net"; net.connect(80, "192.0.2.1");`);
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain("a connection to 192.0.2.1, which is not loopback");
  expect(takeRefused()).toEqual([
    expect.stringMatching(/^in a child process: a connection to 192\.0\.2\.1, which is not loopback/),
  ]);
});

it("lets it reach loopback", () => {
  const child = node(
    `import net from "node:net"; const s = net.connect(1, "127.0.0.1"); s.on("error", () => process.exit(0));`,
  );
  expect(child.status, child.stderr).toBe(0);
  expect(takeRefused()).toEqual([]);
});
