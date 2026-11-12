import { expect, it } from "vitest";
import { unpreparedChannelApps } from "../src/cli/commands/deploy/channel-apps.ts";

// Which apps a deploy makes or prepares; that it makes them in the file it is given, for the person it has, and before
// anything reaches the host is deploy-prepare-order.test.ts's.

it("creates missing apps for either way and prepares an existing webhook app without its token", () => {
  const channels = [
    { name: "feishu", ingress: "webhook" },
    { name: "lark", ingress: "long-connection" },
    { name: "telegram", ingress: "webhook" },
  ] as const;
  expect(unpreparedChannelApps(channels, new Map())).toEqual([
    { kind: "feishu", way: "webhook" },
    { kind: "lark", way: "connection" },
  ]);
  const values = new Map([
    ["FEISHU_APP_ID", "f"],
    ["FEISHU_APP_SECRET", "fs"],
    ["LARK_APP_ID", "l"],
    ["LARK_APP_SECRET", "ls"],
  ]);
  expect(unpreparedChannelApps(channels, values)).toEqual([{ kind: "feishu", way: "webhook" }]);
  values.set("FEISHU_VERIFICATION_TOKEN", "t");
  expect(unpreparedChannelApps(channels, values)).toEqual([]);
  values.set("FEISHU_VERIFICATION_TOKEN", " ");
  expect(unpreparedChannelApps(channels, values)).toEqual([{ kind: "feishu", way: "webhook" }]);
});
