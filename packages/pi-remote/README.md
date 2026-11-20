# @fastagent-sh/pi-remote

Pi extension for connecting directly to deployed [FastAgent](https://fastagent.sh) instances over HTTP or Amazon Bedrock AgentCore.

## Install

```bash
pi install npm:@fastagent-sh/pi-remote
```

Or try it for one session:

```bash
pi -e npm:@fastagent-sh/pi-remote
```

## Configure remotes

Run `/fa` inside Pi to add a remote interactively, or create `~/.config/fastagent/remotes.json` (overridable via `FASTAGENT_REMOTES_PATH`, shared with `fastagent invoke --remote <name>` and `fastagent schedules --remote <name>`):

```json
{
  "default": "ops",
  "remotes": {
    "ops": {
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

- **Smart entry:** run `/fa` to pick a remote (or set one up) when disconnected, or open the remote action menu when connected.
- **Direct connect:** `/fa <name>` or `/fa https://ops.example.com [apiKey]` (or start with `pi --fa ops`). Each connection starts a fresh remote session like local Pi; use `/resume` to switch to an existing session.
- **Native Pi workflow while connected:**
  - `/resume`, `/new`, `/name`, `/session`, `/copy`, `/fork`, `/clone`, `/model`, `/thinking`, `/compact`, `/login`, `/logout`, and shortcuts (`Ctrl+L`, `Ctrl+P`, `Shift+Tab`, copy, session shortcuts) route directly to the connected remote and restore local Pi behavior after `/fa off`.
  - Send text and images normally. While the remote agent is running, `Enter` steers, `Alt+Enter` queues, and `Esc` cancels.
  - The first user message on an untitled session automatically sets a concise session title.
- **Remote management commands:** `/fa off`, `/fa sessions`, `/fa clock` (schedules & wake-ups), `/fa login` / `/fa logout` (remote server credentials), `/fa remotes` (add/remove/switch), `/fa delete`, `/fa status`.
