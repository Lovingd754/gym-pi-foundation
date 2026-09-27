# GymPi MCP and ChatGPT

GymPi exposes a read-only Streamable HTTP MCP endpoint at `/mcp`. It lets
external AI agents inspect the trainee context without changing saved data.

## Connect ChatGPT

1. Sign in to GymPi and open **Settings -> ChatGPT and MCP**.
2. Create a connection. The current MCP tool surface is read-only.
3. Copy the connector URL immediately. Its secret token is shown only once.
4. In ChatGPT Developer Mode, create a custom connector and paste the URL.
5. Select **No authentication**. The private query token in the URL is the
   authentication credential for this personal deployment.

The public URL must use HTTPS. A local or LAN URL is not suitable for ChatGPT.

## Security model

- Raw tokens are never stored; PostgreSQL contains only their SHA-256 hashes.
- Tokens belong to one GymPi user and can be revoked from Settings.
- The server advertises only read tools. A legacy token's stored write flag does
  not expose program-writing tools.
- The agent never receives direct database, filesystem or shell access.
- The connector URL carries the token as a query string, so treat the URL
  itself as a secret: query strings routinely end up in reverse-proxy and
  access logs and in browser history. Disable or scrub query-string logging
  on any proxy in front of GymPi, and prefer the `Authorization: Bearer`
  or `X-GymPi-Token` header (both are supported) for MCP clients that can
  send headers.

For a shared or publicly distributed ChatGPT app, replace personal query-token
authentication with OAuth before submission.

## MCP capabilities

Resources:

- `gympi://instructions/agent`

Prompts:

- `build-training-program`

Read tools:

- `get_training_context`
- `list_exercises`
- `list_programs`
- `get_program`

Program changes must be reviewed and confirmed inside GymPi.

## Health check

`GET /mcp/health` returns `401` without a token and `200` for an active token.
