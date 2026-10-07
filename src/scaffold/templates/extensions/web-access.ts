// Web access for the agent: web_search, fetch_content (readable pages, PDFs, GitHub repos cloned locally) and
// get_search_content, from @fastagent-sh/pi-web-access: fastagent's build of the pi package pi-web-access
// (https://pi.dev/packages/pi-web-access) that keeps each conversation's results its own when the agent serves several
// at once (https://github.com/fastagent-sh/pi-web-access). It works with no key: searches go to Exa, or to OpenAI's
// search when the agent signs in with a ChatGPT subscription (openai-codex). It blocks fetches of private and reserved
// addresses by default, so a served agent cannot be talked into reading your network through it. Keys and more
// providers: ~/.pi/agent/web-search.json on the machine that serves the agent (see the package README). Not wanted?
// Delete this file and `npm uninstall @fastagent-sh/pi-web-access`.
import webAccess from "@fastagent-sh/pi-web-access";

// Its tools only. The package also registers /websearch, /curator, /google-account and /search: terminal commands that
// open a browser on the serving machine or rewrite its ~/.pi/agent/web-search.json. A served agent offers every
// registered command to its callers, so they are not registered here.
export default function web(pi: Parameters<typeof webAccess>[0]) {
  return webAccess(
    new Proxy(pi, { get: (target, key) => (key === "registerCommand" ? () => {} : Reflect.get(target, key)) }),
  );
}
