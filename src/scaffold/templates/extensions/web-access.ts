// Web access for the agent: web_search, fetch_content (readable pages, PDFs, GitHub repos cloned locally) and
// get_search_content, from the pi package pi-web-access (https://pi.dev/packages/pi-web-access). It works with no key:
// searches go to Exa, or to OpenAI's search when the agent signs in with a ChatGPT subscription (openai-codex). It
// blocks fetches of private and reserved addresses by default, so a served agent cannot be talked into reading your
// network. Keys and more providers: ~/.pi/agent/web-search.json on the machine that serves the agent (see the package
// README). Not wanted? Delete this file and `npm uninstall pi-web-access`.
//
// One limit when serving: the package keeps its stored results in the process, shared by every conversation, and
// clears them whenever one starts or ends. A `get_search_content` for a result fetched earlier in a turn can then answer
// "No stored results for responseId …" while another conversation runs at the same time; the agent fetches again.
// What `web_search` and `fetch_content` return directly is not affected.
import webAccess from "pi-web-access";

// Its tools only. The package also registers /websearch, /curator, /google-account and /search: terminal commands that
// open a browser on the serving machine or rewrite its ~/.pi/agent/web-search.json. A served agent offers every
// registered command to its callers, so they are not registered here.
export default function web(pi: Parameters<typeof webAccess>[0]) {
  return webAccess(
    new Proxy(pi, { get: (target, key) => (key === "registerCommand" ? () => {} : Reflect.get(target, key)) }),
  );
}
