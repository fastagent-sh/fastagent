/**
 * A git that reads none of the developer's configuration (identity, hooks, signing, an exported GIT_DIR): what a test
 * that creates an agent runs git with, since creating one commits.
 */
export const hermeticGit: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** {@link hermeticGit} with a commit identity. */
export const withGitIdentity: NodeJS.ProcessEnv = {
  ...hermeticGit,
  GIT_AUTHOR_NAME: "a",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "a",
  GIT_COMMITTER_EMAIL: "a@example.com",
};

/** Run the rest of this file's tests (in-process git calls included) under {@link withGitIdentity}. */
export function useGitIdentity(stubEnv: (name: string, value: string | undefined) => unknown): void {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) stubEnv(key, undefined);
  for (const [key, value] of Object.entries(withGitIdentity)) if (key.startsWith("GIT_")) stubEnv(key, value);
}
