# cello-mcp-http

The CELLO MCP tools over MCP Streamable HTTP, for clients that reach an MCP server by URL rather
than by starting a local process.

It runs on the machine where your CELLO daemon runs, beside it, and forwards every tool call to the
daemon over `~/.cello/daemon.sock`, exactly as the stdio shim (`@cello-protocol/connect`) does. It
holds no keys and runs no node. The tools, their descriptions and their parameters come from
`@cello-protocol/connect` itself, so they are the stdio shim's, never a copy.

## Start it

```
npx @cello-protocol/mcp-http --port 8787 --token-file ~/.cello/mcp-http.token \
    [--agents alice,bob] [--tools-file ~/.cello/mcp-http.tools]
```

Run `npx @cello-protocol/mcp-http --help` for every flag.

- **Token (required).** Every request carries `Authorization: Bearer <token>`. The file must be
  readable by your user alone (`chmod 600`), or set `CELLO_MCP_HTTP_TOKEN`. No token, no start.
  ```
  openssl rand -hex 32 > ~/.cello/mcp-http.token && chmod 600 ~/.cello/mcp-http.token
  ```
- **`--agents`.** The agents this endpoint may act as, by name or pubkey, comma-separated. Each must
  exist on the daemon, or startup fails naming what is unknown and what exists. Any other agent is
  refused `agent_not_permitted`. Omit it to allow every agent.
- **`--tools-file`.** One tool name per line; `*` means every tool; `-name` removes one; blank lines
  and `#` lines are ignored. The names are the `cello_*` tools. An unknown name stops startup and is
  named. A file you give is followed exactly. With no file, every tool is exposed except
  `cello_config_set`, `cello_settings_set`, `cello_set_agent_offline` and `cello_contact_set_tier`.
  An excluded tool is absent from `tools/list`, and calling it is refused `tool_not_permitted`.
- **Where it listens.** `127.0.0.1` by default. Any other `--host` requires `--tls-cert` and
  `--tls-key`. TLS and public exposure are yours: put your own TLS or tunnel in front.

The allowlists limit this endpoint only. Any local program that can open the daemon socket is not
limited by them.

## Point a client at it

Give the client the URL (`http://127.0.0.1:8787/mcp`, or your TLS URL) and the header
`Authorization: Bearer <token>`.

For Claude Code, this repository is also a plugin marketplace:

```
export CELLO_MCP_URL=https://your-host/mcp
export CELLO_MCP_TOKEN=<token>
/plugin marketplace add Mygentic-AI/cello-mcp-http
/plugin install cello-remote@cello-remote
```

If CELLO runs on the same machine as Claude Code, use the `cello` plugin from
`Mygentic-AI/cello-client` instead; it needs no endpoint.
