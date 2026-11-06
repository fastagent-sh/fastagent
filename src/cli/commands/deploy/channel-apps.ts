/**
 * The production Feishu or Lark app a deploy sets up on the spot when the target's values hold none: the same
 * `channels setup` a person runs by hand, aimed at the production value file (channel-setup.md §6).
 */
import type { DeclaredChannel } from "../../../channels/discover.ts";
import type { SetupWay } from "../../../channels/setup.ts";
import { dotEnvPath } from "../../../value-file.ts";
import { type SetupKind, setUpChannel, setupNames } from "../../channel-setup.ts";
import type { Person } from "../../person.ts";

export interface ChannelAppSetup {
  kind: "feishu" | "lark";
  way: SetupWay;
}

/** The names of the values `app`'s setup would keep. */
export const channelAppNames = ({ kind, way }: ChannelAppSetup): string[] => setupNames(kind, way);

/** The Feishu and Lark channels whose app has no value yet in `values`. */
export function unpreparedChannelApps(
  channels: readonly DeclaredChannel[],
  values: ReadonlyMap<string, string>,
): ChannelAppSetup[] {
  return (["feishu", "lark"] as const).flatMap((kind) => {
    const channel = channels.find((entry) => entry.name === kind);
    if (!channel) return [];
    const way = channel.ingress === "webhook" ? "webhook" : "connection";
    return setupNames(kind, way).some((name) => !values.get(name)?.trim()) ? [{ kind, way }] : [];
  });
}

/** Set each of `apps` up for production, its person's steps taken by `person` (absent: at this terminal). */
export async function prepareChannelApps(
  agentDir: string,
  apps: readonly ChannelAppSetup[],
  rerun: string,
  person?: Person,
): Promise<void> {
  const file = dotEnvPath(agentDir);
  for (const { kind, way } of apps) {
    console.error(`[fastagent] ${kind}: preparing the production app for ${way} in ${file}`);
    const input = { kind: kind satisfies SetupKind, agentDir, file, way, dev: false, rerun };
    await setUpChannel(person === undefined ? input : { ...input, person });
  }
}
