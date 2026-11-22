/**
 * `@fastagent-sh/pi-remote`: Pi extension for connecting directly to deployed FastAgent instances over HTTP or
 * installed cloud transport extensions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFastAgentRemoteExtension } from "./extension.ts";

/** @public */
export default function fastAgentRemoteExtension(pi: ExtensionAPI): void {
  registerFastAgentRemoteExtension(pi);
}
