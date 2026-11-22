# Basic Support Agent

A self-contained FastAgent directory combining `SYSTEM.md`, an Agent Skill (`skills/refund-policy/`), and a portable TypeScript tool (`src/tools/lookup-order.ts`) using `defineTool`.

## Run locally

```bash
npm install
npx @fastagent-sh/fastagent info
npx @fastagent-sh/fastagent invoke "Can I get a refund for order ORD-9231?"
```

On the first interactive run, FastAgent prompts you to select a model and sign in.

## Serve over HTTP

```bash
FASTAGENT_API_KEY=dev-secret npm run dev
```

In another terminal, invoke the running server directly or try [`../client-invoke/`](../client-invoke/):

```bash
npx @fastagent-sh/fastagent invoke --conversation customer-42 "What is the status of ORD-7702?"
```

## Build for embedding or deployment

```bash
npm run build
npx @fastagent-sh/fastagent deploy init docker
```
