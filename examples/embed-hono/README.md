# Embed FastAgent in Hono

Shows how to open a compiled FastAgent inside your own Hono backend using `openAgent()`:

- `POST /chat`: custom application endpoint streaming SSE events via `agent.invokeStream()`.
- `/agent/*`: mounts `service.fetch` directly for `/agent/health` and (when `FASTAGENT_API_KEY` is set) `/agent/v1/*`.

## Run

1. Build [`../basic-agent/`](../basic-agent/) first:
   ```bash
   cd ../basic-agent && npm install && npm run build
   ```
2. Install and start the Hono server:
   ```bash
   cd ../embed-hono
   npm install
   OPENAI_API_KEY=sk-... FASTAGENT_MODEL=openai/gpt-5.5 npm start
   ```
3. Stream a reply from your custom endpoint:
   ```bash
   curl -N -X POST http://127.0.0.1:3000/chat \
     -H "Content-Type: application/json" \
     -d '{"conversation": "customer-42", "message": "Check order ORD-9231"}'
   ```
