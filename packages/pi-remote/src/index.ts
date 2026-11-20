/**
 * `@fastagent-sh/pi-remote`: Pi extension for connecting directly to deployed FastAgent instances over HTTP or
 * Amazon Bedrock AgentCore.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REMOTE_ENTRY_TYPE, registerFastAgentRemoteExtension } from "./extension.ts";

/** @public */
export default function fastAgentRemoteExtension(pi: ExtensionAPI): void {
  registerFastAgentRemoteExtension(pi);
}

/** @public */
export { REMOTE_ENTRY_TYPE, registerFastAgentRemoteExtension };

/** @public */
export {
  type ActiveTool,
  type ConnectionStatus,
  type LiveReply,
  RemoteController,
  type RemoteControllerCallbacks,
  type RemoteControllerOptions,
  type RemoteViewState,
  type RetryNotice,
  buildSendContent,
} from "./controller.ts";

/** @public */
export {
  type AgentCoreRemoteConfig,
  type HttpRemoteConfig,
  type LoadRemotesOptions,
  type RemoteConfig,
  type RemotesFile,
  connectRemote,
  defaultRemotesPath,
  isHttpUrl,
  loadRemotes,
  removeRemote,
  saveRemote,
} from "./remotes.ts";

/** @public */
export { TerminalStatusReporter, type TerminalStatusOptions } from "./terminal-status.ts";
