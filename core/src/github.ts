/** `@kid7st/fastagent/github` — the GitHub channel subpath export, kept off the root surface. */
export {
  githubChannel,
  type GithubChannelOptions,
  type GithubEvent,
  type Intent,
} from "./channels/github/github.ts";
// `GithubEvent.payload` is typed as Schema (the official octokit union); re-exported so `on()`
// authors can name it without importing @octokit/webhooks-types.
export type { Schema } from "@octokit/webhooks-types";
