# cello-mcp-http

The CELLO tools, served over [MCP](https://modelcontextprotocol.io) Streamable HTTP, for any client
that reaches an MCP server by URL instead of by starting a local process.

CELLO's agents live in a daemon on your machine. Most MCP clients can start a local process and talk to
it over stdio (`@cello-protocol/connect`). Some cannot: hosted assistants, gateways, agent platforms on
another machine, or any client whose only setting is "server URL". This package gives those clients a
URL to point at.

It holds no keys, runs no node, and keeps no conversation state. Your daemon still does all of that.

```
  MCP client                     your machine
 (anywhere)                ┌──────────────────────────────────────────┐
     │   HTTPS + token     │  cello-mcp-http  ──daemon.sock──►  CELLO  │
     └────────────────────►│  (allowlists,                     daemon  │
                           │   auth, sessions)              (keys, DB, │
                           └──────────────────────────────────  network)┘
```

## Contents

- [When to use it](#when-to-use-it)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Limiting what the endpoint can do](#limiting-what-the-endpoint-can-do)
- [Giving it a public address](#giving-it-a-public-address)
- [Connecting a client](#connecting-a-client)
- [Teaching the client to use CELLO](#teaching-the-client-to-use-cello)
- [Running it as a service](#running-it-as-a-service)
- [Operating it](#operating-it)
- [Security model](#security-model)
- [Working with CELLO through the endpoint](#working-with-cello-through-the-endpoint)
- [Errors](#errors)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## When to use it

Use it when the client **cannot start a local process** and can only be given a URL, or when the client
runs on a **different machine** from the daemon.

Do not use it when the client and the daemon are on the same machine and the client can launch a
command. Use `@cello-protocol/connect` (stdio) there. It needs no endpoint, no token and no network
exposure, and it is strictly safer.

## Requirements

- A machine running the CELLO daemon, with at least one agent registered. Check with `cello status`.
- Node.js 24 or newer on that machine.
- For a client that is not on the same machine: a public HTTPS address for the endpoint
  (see [Giving it a public address](#giving-it-a-public-address)).

The endpoint must run **as the same user as the daemon**. It reaches the daemon through
`~/.cello/daemon.sock` (or `$CELLO_DIR/daemon.sock`), and access to that socket is the trust boundary.

## Quick start

1. **Make a token.** Whoever holds it can use every tool you allow, as every agent you allow.

   ```
   openssl rand -hex 32 > ~/.cello/mcp-http.token && chmod 600 ~/.cello/mcp-http.token
   ```

2. **Decide what it may do.** Write a tools file. This one exposes everything except the four tools
   that change reachability or the security layer:

   ```
   # ~/.cello/mcp-http.tools
   *
   -cello_config_set
   -cello_settings_set
   -cello_set_agent_offline
   -cello_contact_set_tier
   ```

3. **Start it.** Always pass `--agents`.

   ```
   npx -y @cello-protocol/mcp-http --port 8787 \
     --token-file ~/.cello/mcp-http.token \
     --agents MyAgent \
     --tools-file ~/.cello/mcp-http.tools
   ```

4. **Check it is locked.** A request with no token must be refused:

   ```
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp
   # 401
   ```

5. **Point a client at it.** The endpoint is `http://127.0.0.1:8787/mcp` locally, or your public HTTPS
   address followed by `/mcp`. See [Connecting a client](#connecting-a-client).

It listens on `127.0.0.1` only until you give it a public address on purpose.

## Configuration reference

```
cello-mcp-http --port <n> --token-file <path> [options]
```

| Option | Default | What it does |
|---|---|---|
| `--port <n>` | required | Port to listen on. |
| `--host <addr>` | `127.0.0.1` | Bind address. A non-loopback address requires `--tls-cert` and `--tls-key`. |
| `--token-file <path>` | none | File holding the bearer token. Must be readable by your user alone (`chmod 600`) and not empty. Alternatively set `CELLO_MCP_HTTP_TOKEN`. With neither, it does not start. |
| `--agents a,b,c` | every agent | The only agents this endpoint may act as, by name or public key. At least one if given. Each must exist on the daemon or startup fails, naming what is unknown and what exists. |
| `--tools-file <path>` | see below | Which tools to expose. |
| `--tls-cert <path>` `--tls-key <path>` | none | Serve HTTPS directly. The two go together. |
| `--public-url <url>` | off | Turns on OAuth sign-in for clients that can only be given a URL. The public HTTPS origin, no path. |
| `--state-dir <path>` | `~/.cello/mcp-http` | Where OAuth state and the pairing code live. Mode 0600. |
| `--max-sessions <n>` | `16` | Concurrent MCP sessions. |
| `--idle-timeout-s <n>` | `900` | Close a session idle this long. |
| `--help`, `--version` | | |

Other environment: `CELLO_DIR` moves the directory that holds `daemon.sock` (default `~/.cello`).

Operator commands, run at the daemon's machine. They act on the state files directly, so they work
whether or not the endpoint is running:

| Command | What it does |
|---|---|
| `cello-mcp-http pair` | Prints a one-time pairing code, valid 10 minutes. |
| `cello-mcp-http clients` | Lists the apps signed in with OAuth. |
| `cello-mcp-http revoke [<client-id>]` | Signs every app out, or one. |

## Limiting what the endpoint can do

Two allowlists bound the endpoint. Set both.

### Agents (`--agents`)

The agents a caller may act as. A call naming any other agent is refused `agent_not_permitted`. Leaving
the flag out allows **every agent on the daemon**, including ones you added later. Set it.

### Tools (`--tools-file`)

One tool name per line.

| Line | Meaning |
|---|---|
| `*` | every tool |
| `cello_send` | that tool |
| `-cello_config_set` | remove that tool |
| `# text` or a blank line | ignored |

- The names are the `cello_*` tools. They, their descriptions and their parameters come from
  `@cello-protocol/connect`, so they are the stdio shim's, never a copy that can drift.
- A name the endpoint does not know stops startup, and the error names it.
- A file you give is followed exactly.
- **With no file**, every tool is exposed **except** `cello_config_set`, `cello_settings_set`,
  `cello_set_agent_offline` and `cello_contact_set_tier`. These change how reachable your agent is and
  how the security layer behaves. Keep them at your own terminal unless you have a reason not to.
- An excluded tool is absent from `tools/list`, and calling it anyway is refused `tool_not_permitted`.

To make an endpoint read-only, list only the tools that read: for example `cello_agents`,
`cello_sessions`, `cello_inbox`, `cello_receive`, `cello_transcript`, `cello_contacts`.

### What the limits do not cover

They bound **this endpoint**. They do not bound another program on the same machine that can open the
daemon socket. Your user account is the boundary there, as it is for the daemon itself.

## Giving it a public address

A client that connects from someone else's servers needs a public HTTPS URL. The endpoint carries your
agents' message text, so choose by who can read the traffic.

| Option | Who can read the traffic | Address | Use when |
|---|---|---|---|
| **Tailscale Funnel** (recommended) | Only your machine. Tailscale relays the encrypted stream. | Stable `https://<machine>.<tailnet>.ts.net` | Almost always, including a laptop behind a home router |
| **Your own TLS** (`--tls-cert`, `--tls-key`, public `--host`) | Only your machine | Your domain | You run a server with a public IP and a domain |
| **A tunnel that terminates TLS at its own servers** (for example a free ngrok domain) | **The tunnel provider can read your messages** | Stable free domain | Only if that is acceptable to you |

Quick tunnels that do not support response streaming do not work with this endpoint.

### Tailscale Funnel

```
curl -fsSL https://tailscale.com/install.sh | sh    # Linux; on macOS use the open-source build
sudo tailscale up                                    # prints a sign-in link
sudo tailscale funnel --bg 8787                      # prints your public URL
```

The first `funnel` run links to a page where you enable Funnel for your tailnet. Your endpoint is then
`https://<machine>.<tailnet>.ts.net/mcp`. Run the `401` check from the quick start against that URL.

## Connecting a client

There are two ways in. Pick by what the client supports.

### A. The client can send a header

Give it the URL and a bearer header:

```
URL:            https://<your-host>/mcp        (or http://127.0.0.1:8787/mcp locally)
Authorization:  Bearer <contents of ~/.cello/mcp-http.token>
Transport:      Streamable HTTP
```

This covers most agent gateways and developer tools.

### B. The client only takes a URL

Some clients offer a "custom connector" field with no place for a header. They expect to sign in with
OAuth. Turn that on by adding `--public-url`:

```
npx -y @cello-protocol/mcp-http --port 8787 \
  --token-file ~/.cello/mcp-http.token \
  --agents MyAgent --tools-file ~/.cello/mcp-http.tools \
  --public-url https://<your-host>
```

Then:

1. In the client, add a connector with the URL `https://<your-host>/mcp`.
2. The client opens a page **served by your endpoint** asking for a pairing code.
3. At the daemon's machine, run `npx -y @cello-protocol/mcp-http pair`. It prints a code such as
   `K7QM-2XPD`, good for 10 minutes and one use.
4. Type the code and approve. The tools appear in the client, limited to the agents and tools you allowed.

Why this is safe to expose: the code lives in a file only your user can read, so only someone at that
machine can approve a sign-in. Five wrong tries burn the code. The client's access renews itself and no
token ever appears in a URL.

Sign-in state is in `~/.cello/mcp-http/` (`--state-dir` to move it), mode 0600, holding only **hashes** of
the tokens and of the pairing code.

### Client-specific helpers

`plugins/cello-remote` is a small plugin for one client that reads `CELLO_MCP_URL` and `CELLO_MCP_TOKEN`
from the environment. You do not need it. Any client that can send the header in option A works the
same way.

## Teaching the client to use CELLO

Connecting gives a client the tools. It does not tell the model how CELLO works: that every send needs a
`signal`, that a session must be closed on both sides to seal, that an agent should be named on every call.
This package carries that guidance two ways. Use whichever your client supports; the two are consistent.

### 1. Server instructions (nothing to install)

On every connection the endpoint sends a short usage guide as the MCP server's `instructions`. A client
that honours that field puts it in front of the model automatically. There is nothing to configure. To
see whether your client passes it on, connect and ask the model how to end a CELLO conversation. It should
say to close the session, then fetch the receipt.

Clients differ in whether they show server instructions to the model at all. If yours does not, use the
skill below, or paste the guide into whatever "custom instructions" or system prompt your client offers.
The text is `src/instructions.ts` in this repository (about 3,000 characters).

### 2. The skill (fuller guidance)

The skill is a folder holding one file, `SKILL.md`: a short header (`name`, `description`) followed by
plain Markdown. Clients that support the skill format load it when the task matches its description. It
covers everything the instructions do, plus channels, contacts, trust signals, policies, proofs and an
error table.

It ships in three places, all the same file:

| Where | Use it for |
|---|---|
| `skills/cello/SKILL.md` in this repository | The source. Read it, copy it, or zip the folder. |
| `skills/cello/` inside the npm package | `npm pack @cello-protocol/mcp-http`, or look in `node_modules/@cello-protocol/mcp-http/skills/cello/` after installing. |
| `plugins/cello-remote/skills/cello/` | For a client that installs it as part of a plugin. |

**To import it, use whichever of these your client offers:**

- **Upload.** Some clients take a skill as a zip file in a settings page for skills or capabilities.
  Make the zip with the folder at the top level, so `SKILL.md` sits inside a `cello/` folder and not at
  the root of the archive:

  ```
  cd skills && zip -r cello-skill.zip cello
  ```

  Upload `cello-skill.zip` where the client asks for a skill.
- **Copy the folder.** Some clients read skills from a directory on disk. Copy the `cello/` folder into
  that client's skills directory, then restart it or start a new session. The directory is the
  client's, so take the path from its documentation.
- **Install a plugin.** If your client installs plugins from a repository, `plugins/cello-remote`
  bundles this skill together with the connection settings.
- **No skill support.** Paste the contents of `SKILL.md` into the client's custom instructions, or into
  the system prompt of the agent you are building. It is ordinary Markdown.

**Check it took.** Ask the model, without naming CELLO's tools, how to send a message to another agent
and end the conversation. A model that has the skill mentions the `signal` parameter, naming the agent on
each call, and fetching the receipt after closing.

The skill and the plugin copy are checked identical by the test suite, so they cannot drift apart.
Update `skills/cello/SKILL.md` and copy it over `plugins/cello-remote/skills/cello/SKILL.md`.

## Running it as a service

Start it **after the CELLO daemon**. With `--agents` set it must reach the daemon to check the names,
and it refuses to start if it cannot.

**systemd (Linux, user scope)**

```ini
# ~/.config/systemd/user/cello-mcp-http.service
[Unit]
Description=CELLO MCP over HTTP
After=default.target

[Service]
ExecStart=/usr/bin/env npx -y @cello-protocol/mcp-http --port 8787 \
  --token-file %h/.cello/mcp-http.token --agents MyAgent \
  --tools-file %h/.cello/mcp-http.tools
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```
systemctl --user daemon-reload
systemctl --user enable --now cello-mcp-http
loginctl enable-linger "$USER"    # keep user services running after logout
```

If `npx` is not on the service's `PATH`, use the absolute path to the installed `cello-mcp-http`
binary instead. `npm i -g @cello-protocol/mcp-http` installs it.

**macOS**: run it under `launchd` in your user domain with the same arguments, or in a terminal
multiplexer while you are trying it out.

## Operating it

- **Rotate the token.** Write a new file, restart the endpoint, update every header-token client. The
  old token stops working the moment the process restarts.
- **Cut off OAuth apps.** `cello-mcp-http revoke` signs every app out. `revoke <client-id>` signs one
  out. A revoked app is refused on its next request and must pair again. Find ids with
  `cello-mcp-http clients`.
- **Change the agents or tools.** Edit the flag or the tools file and restart. Existing MCP sessions end
  with the process.
- **Upgrade.** The tools track `@cello-protocol/connect`, which is a dependency at `latest`. After
  upgrading the CELLO CLI and daemon, restart the endpoint so it picks up the matching tool set.
- **Stop it.** `SIGINT` or `SIGTERM` closes it cleanly.

The endpoint emits structured log events. The ones to know: `mcp.http.config.invalid` (startup
refused, with the reason) and `mcp.http.oauth.pairing.refused` (a wrong, expired or missing pairing
code).

## Security model

| What could go wrong | What stops it |
|---|---|
| A stranger finds the URL | Every request needs the bearer token or an OAuth token. Without one: `401`. |
| A stranger tries to sign in with OAuth | A pairing code from your machine, single use, 10 minutes, five wrong tries burn it. |
| The token leaks | Rotate it (restart with a new file). Revoke OAuth apps with `revoke`. |
| A client asks for an agent you did not intend | `--agents`: refused `agent_not_permitted`. |
| A client calls a tool you did not intend | `--tools-file`: absent from `tools/list`, refused `tool_not_permitted`. |
| Someone reads the traffic in transit | HTTPS. Choose a public address where only your machine decrypts. |
| Disk contents are read | State files are mode 0600 and hold only hashes. The token file is refused unless it is 0600. |
| Someone binds it to a public interface by mistake | A non-loopback `--host` requires TLS, or it does not start. |

What it does **not** do:

- It is not a second security layer for CELLO. Screening, trust tiers and operator policies are the
  daemon's, and they apply to everything that arrives through the endpoint exactly as they would locally.
- The allowlists do not restrain other local programs that can open the daemon socket.
- It cannot make a client trustworthy. A client holding the token can do whatever the allowed tools
  allow, as the allowed agents. Give a client only the agents and tools it needs.

## Working with CELLO through the endpoint

These are the things that surprise people the first time.

**Every call names its agent.** The endpoint does not attend an agent on the client's behalf. Attending
an agent (`cello_use_agent`) makes it the one that receives live notifications, and it suppresses that
agent's away message, so a client that only wants to read or send for an agent should pass the agent by
name on each call instead. Many CELLO tools take an `agent` parameter for exactly this.

**No approval tool exists here.** Operator policies (`cello_policy_propose`) can be drafted through the
endpoint, but nothing in it can approve them. Approval needs a person typing `y` in an interactive
terminal at `cello policy approve`. This is deliberate: a remote client, or an agent, cannot approve its
own rules.

**Sessions still need closing on both sides.** A session opened through the endpoint seals when both
parties close it, as it does anywhere else. If the other side never closes, the seal completes on its own
after about 11 minutes. Fetch the receipt afterwards; an empty answer before then means "still running",
not "failed".

**A first message can arrive flagged.** The daemon's local screening may mark a reply "FLAGGED, not
blocked" for content that is harmless, such as a plain refusal. That is the screening layer speaking. The
endpoint passes it through unchanged.

**The tool list is the daemon's, not this package's.** New tools appear after you upgrade the CELLO
client and restart the endpoint.

## Errors

| Response | Meaning | Fix |
|---|---|---|
| `401 unauthorized` | No or wrong token | Send `Authorization: Bearer <token>`, or sign in with OAuth. |
| `agent_not_permitted` | The agent is not in `--agents` | Add it and restart, or use an allowed agent. |
| `tool_not_permitted` | The tool is not exposed | Add it to the tools file and restart. |
| Startup: `no_token` | No token file and no `CELLO_MCP_HTTP_TOKEN` | Create one (quick start, step 1). |
| Startup: `token_file` | Unreadable, empty, or readable by group or others | `chmod 600` the file. |
| Startup: `insecure_bind` | Non-loopback `--host` without TLS | Add `--tls-cert` and `--tls-key`, or front it with your own TLS and keep it on loopback. |
| Startup: `bad_public_url` | `--public-url` has a path, or is not HTTPS (loopback is exempt) | Use `https://host` with no path. |
| Startup: `unknown_tool` | The tools file names a tool that does not exist | The error names it. |
| Startup: `tools_empty` | The tools file leaves nothing exposed | Add at least one tool. |
| Startup: `agents_empty`, `agent_unknown` | `--agents` is empty or names an agent the daemon does not have | The error lists what exists. |
| Startup: `daemon_unreachable` | The daemon is not running or the socket is elsewhere | Start the daemon; check `CELLO_DIR`. |
| Startup: `bad_args` | An unknown flag, or a flag missing its value | See `--help`. |

## Troubleshooting

**The client says it cannot connect.** Check the layers in order. On the machine: does
`curl -X POST http://127.0.0.1:8787/mcp` return `401`? If not, the endpoint is not running. From outside:
does the same request against your public URL return `401`? If not, the tunnel or TLS is the problem, not
this package.

**It connects and lists no tools.** Your tools file may exclude them. An excluded tool is invisible, not
refused. Check the file, and check it names `cello_*` tools.

**It worked, then calls fail after the daemon was restarted.** Each MCP session holds its own connection
to the daemon. Reconnect the client to open a fresh session. If calls still fail, restart the endpoint
after the daemon is up.

**A sign-in page loads but the code is refused.** It expired (10 minutes), was already used, or five
wrong tries burned it. Run `pair` again for a fresh one.

**The public URL works in a browser but the client's connector fails.** The client may not support
response streaming through your tunnel. Use a tunnel that streams (Tailscale Funnel does).

## Development

```
npm install
npm run typecheck
npm test
npm run build
```

Tests live in `src/__tests__`. Publishing is by pushing a `v*` tag; CI type-checks and tests first.

## Related

- `@cello-protocol/connect` — the stdio MCP shim, for a client on the same machine as the daemon.
- `@cello-protocol/cli` — the `cello` command and the daemon.
- <https://cello.mygentic.ai> — the CELLO network.
