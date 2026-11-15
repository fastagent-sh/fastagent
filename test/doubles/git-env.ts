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
