/** The single approved `process.env` boundary for `@fastagent-sh/pi-remote`. */
export function hostEnv(): NodeJS.ProcessEnv {
  return process.env;
}
