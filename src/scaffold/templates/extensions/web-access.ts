// Web access for the agent: web_search, fetch_content (readable pages, PDFs, GitHub repos cloned locally) and
// get_search_content, from the pi package pi-web-access (https://pi.dev/packages/pi-web-access). It works with no key:
// searches go to Exa, or to OpenAI's search when the agent signs in with a ChatGPT subscription (openai-codex). It
// blocks fetches of private and reserved addresses by default, so a served agent cannot be talked into reading your
// network. Keys and more providers: ~/.pi/agent/web-search.json on the machine that serves the agent (see the package
// README). Not wanted? Delete this file and `npm uninstall pi-web-access`.
export { default } from "pi-web-access";
