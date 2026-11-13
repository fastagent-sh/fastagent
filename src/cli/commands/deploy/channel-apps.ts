/**
 * The production Feishu or Lark app a deploy sets up on the spot when the target's values hold none: the same
 * `channels setup` a person runs by hand, aimed at the file `--env-file` names.
 */
import type { DeclaredChannel } from "../../../channels/discover.ts";
import type { SetupWay } from "../../../channels/setup.ts";
import { type SetupKind, setUpChannel, setupNames } from "../../channel-setup.ts";

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

/** Set each of `apps` up for production in an interactive terminal. */
export async function prepareChannelApps(
  agentDir: string,
  file: string,
  apps: readonly ChannelAppSetup[],
  rerun: string,
): Promise<void> {
  for (const { kind, way } of apps) {
    console.error(`[fastagent] ${kind}: preparing the production app for ${way} in ${file}`);
    const outcome = await setUpChannel({
      kind: kind satisfies SetupKind,
      agentDir,
      file,
      way,
      dev: false,
      rerun,
      interactive: true,
    });
    if (outcome.status === "done") {
      for (const line of outcome.after) console.error(`[fastagent] next: ${line}`);
    }
  }
}
