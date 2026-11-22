# FastAgent Examples

Minimal, runnable examples showing the three main ways developers use FastAgent (requires Node ≥ 24.15).

| Example | What it demonstrates | Run |
| --- | --- | --- |
| [`basic-agent`](./basic-agent/) | Complete agent directory: `SYSTEM.md`, a skill (`skills/refund-policy/`), and a portable TypeScript tool (`defineTool`) | `cd examples/basic-agent && npm install && npm run dev` |
| [`embed-hono`](./embed-hono/) | Embed a compiled agent in a Hono app with `openAgent()`, mount `service.fetch`, and stream SSE from a custom `/chat` route | `cd examples/embed-hono && npm install && node server.ts` |
| [`client-invoke`](./client-invoke/) | Call any deployed HTTP FastAgent with `@fastagent-sh/client` (`invoke` with caller-named `conversation` + `invokeStream`) | `cd examples/client-invoke && npm install && node invoke.ts` |
