// Web access for the agent: web_search, fetch_content (readable pages, PDFs, GitHub repos cloned locally),
// get_search_content and source_check, from @fastagent-sh/pi-web-access: fastagent's build of the pi package
// pi-web-access (https://pi.dev/packages/pi-web-access) that keeps each conversation's results its own when the agent
// serves several at once (https://github.com/fastagent-sh/pi-web-access). Where the model can add tools mid-conversation,
// a session starts with web_enable only, and calling it makes the others available. It works with no key: searches go
// to Exa, or to OpenAI's search when the agent signs in with a ChatGPT subscription (openai-codex). Fetches of private
// and reserved addresses are blocked by default. More providers: put their keys (BRAVE_API_KEY, EXA_API_KEY,
// GEMINI_API_KEY, … see the package README) in .secrets/.env, which travels with a deploy; ~/.pi/agent/web-search.json
// on the serving machine also works but stays on that machine. Not wanted? Delete this file and
// `npm uninstall @fastagent-sh/pi-web-access`.
import webAccess from "@fastagent-sh/pi-web-access";

// Its tools only. The package also registers /websearch, /curator, /google-account and /search: terminal commands that
// open a browser on the serving machine or rewrite its ~/.pi/agent/web-search.json. A served agent offers every
// registered command to its callers, so they are not registered here.
export default function web(pi: Parameters<typeof webAccess>[0]) {
  return webAccess(
    new Proxy(pi, { get: (target, key) => (key === "registerCommand" ? () => {} : Reflect.get(target, key)) }),
  );
}
