/**
 * A model of `openai-codex`, the OAuth provider tests sign in to, as `provider/modelId`. pi's own default for it, so it
 * moves with pi's catalog: a literal id goes missing the day pi retires it (`login.test.ts` checks the table against
 * pi's own).
 */
import { PI_DEFAULT_MODELS } from "../src/harnesses/models/login.ts";

export const CODEX_MODEL = `openai-codex/${PI_DEFAULT_MODELS["openai-codex"]}`;
