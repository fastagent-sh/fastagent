# Call FastAgent over HTTP (`@fastagent-sh/client`)

Minimal client example using `@fastagent-sh/client` (zero Node dependencies—works in Node, Bun, Deno, and edge workers). Demonstrates both single-call `agent.invoke()` and live streaming `agent.invokeStream()` with a caller-named `conversation`.

## Run

1. Start an agent serving the HTTP Agent API (for example [`../basic-agent/`](../basic-agent/)):
   ```bash
   cd ../basic-agent
   FASTAGENT_API_KEY=dev-secret npm run dev
   ```
2. Run the client:
   ```bash
   cd ../client-invoke
   npm install
   FASTAGENT_URL=http://127.0.0.1:8787 FASTAGENT_API_KEY=dev-secret npm start
   ```
