# @fastagent-sh/pi-remote

Chat with and operate your deployed [FastAgent](https://fastagent.sh) services directly from the [Pi](https://pi.dev) terminal—over HTTP or installed cloud transports like `@fastagent-sh/client-agentcore`.

## Install

```bash
pi install npm:@fastagent-sh/pi-remote
```

Or try it for one session:

```bash
pi -e npm:@fastagent-sh/pi-remote
```

## Configure remotes

Run `/fa` inside Pi to add a remote interactively, manage HTTP remotes with `fastagent remote add`, or edit `~/.config/fastagent/remotes.json` directly (overridable via `FASTAGENT_REMOTES_PATH`, shared with `fastagent invoke --remote <name>`). Non-HTTP types dynamically load `@fastagent-sh/client-<type>` (for example, `npm i @fastagent-sh/client-agentcore`):

```json
{
  "default": "ops",
  "remotes": {
    "ops": {
      "type": "http",
      "url": "https://ops.example.com",
      "apiKey": "$OPS_AGENT_KEY"
    },
    "bedrock": {
      "type": "agentcore",
      "runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
      "sessionId": "my-agentcore-session-id-at-least-33-chars",
      "qualifier": "prod"
    }
  }
}
```

## Usage

- **Connect:** Run `/fa` to pick or configure a remote when disconnected, or open the remote action menu when connected. Connect directly with `/fa <name>`, `/fa https://ops.example.com [apiKey]`, or `pi --fa ops`.
- **Native Pi workflow while connected:**
  - `/resume`, `/new`, `/name`, `/session`, `/copy`, `/fork`, `/clone`, `/model`, `/thinking`, `/compact`, and shortcuts (`Ctrl+L`, `Ctrl+P`, `Shift+Tab`, copy, session shortcuts) route directly to the remote instance and restore local Pi after `/fa off`.
  - Send text and images normally. While the remote agent is running, `Enter` steers, `Alt+Enter` queues, and `Esc` cancels.
  - The first message in an untitled session sets a concise title automatically.
- **Remote management:** `/fa off`, `/fa sessions`, `/fa key [--clear]` (server API key), `/fa remotes` (add/remove/switch), `/fa delete`, `/fa status`.

See [Remotes & clients](https://fastagent.sh/docs/remotes/).
