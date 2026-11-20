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

Create `~/.config/fastagent/remotes.json` (or point `FASTAGENT_REMOTES_PATH` at a file):

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

- Add & save a remote interactively inside Pi: `/fa add` (or `/fa add ops https://ops.example.com $OPS_AGENT_KEY`)
- Connect directly by URL without saving a config: `/fa connect https://ops.example.com [apiKey]`
- Connect to a saved remote: `/fa connect ops` (or `/fa connect` to pick interactively / guide setup if none saved)
- Connect on startup: `pi --fa ops`
- Send messages and images normally; while the remote agent is running, typing steers it and `Esc` cancels it.
- Commands: `/fa add`, `/fa remove`, `/fa connect`, `/fa disconnect`, `/fa status`, `/fa sessions`, `/fa title`, `/fa delete`, `/fa new`, `/fa fork`, `/fa model`, `/fa thinking`, `/fa compact`, `/fa schedules`, `/fa run <name>`, `/fa wakeups`, `/fa cancel`.
