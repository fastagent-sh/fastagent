/**
 * `@kid7st/fastagent/github` — the GitHub channel entry point (subpath export).
 * Platform-specific channel; kept off the root surface (the root stays the contract + pi + neutral
 * channels). See channels/github.ts.
 */
export {
  githubChannel,
  type GithubChannel,
  type GithubChannelOptions,
  type GithubDelivery,
  type GithubFetchResult,
  type GithubRun,
} from "./channels/github.ts";
