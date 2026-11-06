// The web endpoint as ChatGPT and Claude.ai use it: a real server and daemon, the built endpoint as its own process,
// OAuth sign-in over HTTP, and a fresh MCP session for every call. It proves nothing about those apps themselves.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IpcClient } from "cello-v2/ipc-client";

const serverUrl = process.env["CELLO_URL"] as string;
const PORT = Number(process.env["CELLO_WEB_PORT"] ?? 18621);
const LIMITED_PORT = PORT + 1;
const base = `http://127.0.0.1:${PORT}`;
const root = new URL("..", import.meta.url).pathname;
const bin = join(root, "dist/bin/cello-mcp-http.js");
const cliPath = join(root, "node_modules/cello-v2/dist/cli.js");
const scratch = mkdtempSync(join(tmpdir(), "cello-web-"));
const ownerEnv = { ...process.env, CELLO_V2_HOME: join(scratch, "owner"), CELLO_DIR: join(scratch, "state") } as Record<string, string>;
const peerEnv = { ...process.env, CELLO_V2_HOME: join(scratch, "peer") } as Record<string, string>;
const STATIC = randomBytes(24).toString("hex");
const tokenFile = join(scratch, "token");
writeFileSync(tokenFile, STATIC, { mode: 0o600 });

const cli = (env: Record<string, string>, ...args: string[]): Record<string, unknown> => {
  const out = execFileSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });
  return out.trim().startsWith("{") ? JSON.parse(out) as Record<string, unknown> : {};
};
const peer = (...args: string[]): Record<string, unknown> => cli(peerEnv, ...args, "--agent", "Bob");

interface Running { child: ChildProcess; log: () => string }
function startEndpoint(port: number, extra: string[]): Promise<Running> {
  const child = spawn(process.execPath, [bin, "--port", String(port), "--token-file", tokenFile, ...extra], { env: ownerEnv, stdio: ["ignore", "ignore", "pipe"] });
  let text = "";
  child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (text.includes("mcp.http.listening")) { clearInterval(check); resolve({ child, log: () => text }); }
      if (child.exitCode !== null) { clearInterval(check); reject(new Error(`the endpoint stopped: ${text}`)); }
    }, 50);
  });
}
const stop = (running: Running): Promise<void> => new Promise((resolve) => {
  if (running.child.exitCode !== null) { resolve(); return; }
  running.child.once("exit", () => resolve());
  running.child.kill("SIGKILL");
});
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// One signed-in app. A new MCP session for every call and no goodbye, which is what these apps do.
class App {
  readonly name: string;
  readonly clientId: string;
  readonly bearer: string;
  readonly url: string;
  constructor(name: string, clientId: string, bearer: string, url = `${base}/mcp`) {
    this.name = name;
    this.clientId = clientId;
    this.bearer = bearer;
    this.url = url;
  }
  async session(): Promise<Client> {
    const client = new Client({ name: this.name, version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.bearer}` } } }));
    return client;
  }
  async tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const client = await this.session();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]?.text as string;
      if (result.isError && !text.startsWith("{")) return { isError: true, error: "protocol", message: text };
      return { ...(result.isError ? { isError: true } : {}), ...JSON.parse(text) as object };
    } finally {
      await client.close();
    }
  }
}

async function signIn(name: string): Promise<App> {
  const REDIRECT = "http://127.0.0.1:9/callback";
  const registered = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: `${base}/mcp` });
  const html = await (await fetch(`${base}/authorize?${query}`)).text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] as string;
  const printed = execFileSync(process.execPath, [bin, "pair"], { encoding: "utf8", env: ownerEnv });
  const code = /Pairing code: (\S+)/.exec(printed)?.[1] as string;
  const approved = await fetch(`${base}/authorize/approve`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, code }).toString() });
  const given = new URL(approved.headers.get("location") as string).searchParams.get("code") as string;
  const tokens = await (await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: given, client_id: registered.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${base}/mcp` }).toString() })).json() as { access_token: string };
  return new App(name, registered.client_id, tokens.access_token);
}

let endpoint: Running;
let limited: Running | undefined;
let chatgpt: App;
let claude: App;
let bobId: string;
let annId: string;
let session: string;

before(async () => {
  cli(ownerEnv, "login", "--server", serverUrl);
  cli(peerEnv, "login", "--server", serverUrl);
  endpoint = await startEndpoint(PORT, ["--public-url", base]);
  bobId = (cli(peerEnv, "create-agent", "Bob")["agent_id"]) as string;
  cli(peerEnv, "use-agent", "--agent", "Bob");
});

after(async () => {
  if (endpoint) await stop(endpoint);
  const evidence = join(homedir(), "cello-v2-live-runs", `web-endpoint-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "endpoint.log"), endpoint.log());
  cpSync(join(ownerEnv["CELLO_V2_HOME"] as string, "daemon.log"), join(evidence, "owner-daemon.log"));
  cpSync(join(peerEnv["CELLO_V2_HOME"] as string, "daemon.log"), join(evidence, "peer-daemon.log"));
  if (limited) await stop(limited);
  for (const env of [ownerEnv, peerEnv]) {
    try { cli(env, "logout"); } catch { /* Already stopped. */ }
  }
});

test("a client with no token is refused and pointed at sign-in; two apps sign in; the tools are the table's", async () => {
  const refused = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(refused.status, 401);
  assert.match(refused.headers.get("www-authenticate") ?? "", /resource_metadata/);
  chatgpt = await signIn("ChatGPT");
  claude = await signIn("Claude");
  const client = await chatgpt.session();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.match(client.getInstructions() ?? "", /cello_wait/);
  assert.doesNotMatch(client.getInstructions() ?? "", /cello_await_session|cello_session_id|cello_sealed_receipt/);
  await client.close();
  for (const name of ["cello_use_agent", "cello_send", "cello_wait", "cello_receive", "cello_seal"]) assert.ok(tools.includes(name), name);
  for (const name of ["cello_screening", "cello_retire", "cello_commit_read", "cello_export_transcript", "cello_verify_seal"]) assert.ok(!tools.includes(name), name);
  const schema = (await (async () => { const c = await chatgpt.session(); const t = await c.listTools(); await c.close(); return t; })()).tools.find((t) => t.name === "cello_receive");
  assert.ok(!("defer_commit" in (schema?.inputSchema.properties ?? {})), "a model never sees the commit plumbing");
});

test("two callers are kept apart, with the hold in the caller and not a connection", async () => {
  annId = (await chatgpt.tool("cello_create_agent", { name: "Ann" }))["agent_id"] as string;
  await claude.tool("cello_create_agent", { name: "Cat" });
  await until("both online", () => (JSON.parse(execFileSync(process.execPath, [cliPath, "status"], { encoding: "utf8", env: ownerEnv })) as { agents: { online: boolean }[] }).agents.every((a) => a.online));
  assert.equal((await chatgpt.tool("cello_use_agent", { agent: "Ann" }))["agent_id"], annId);
  // That session has closed, as the app's always do, and the hold stays.
  assert.equal((await claude.tool("cello_use_agent", { agent: "Ann" }))["error"], "agent_held");
  assert.equal((await claude.tool("cello_receive", { agent: "Ann" }))["error"], "agent_held");
  await claude.tool("cello_use_agent", { agent: "Cat" });
  assert.equal((await chatgpt.tool("cello_receive", { agent: "Cat" }))["error"], "agent_held");
  // The caller comes from the token. Claiming another's in the arguments gets nothing.
  assert.equal((await claude.tool("cello_receive", { agent: "Ann", caller: `oauth:${chatgpt.clientId}` }))["error"], "agent_held");
  // Nor can a tool call say a person agreed.
  const loosen = await chatgpt.tool("cello_settings_set", { name: "bounds.unknown.max_sessions", value: "9", agent: "Ann", person_confirmed: true });
  assert.equal(loosen["error"], "person_required");
});

test("wait, then receive: a new caller, a message, a reply, a close and a seal", async () => {
  const caller = chatgpt.tool("cello_wait", { agent: "Ann", timeout_seconds: 30 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  session = peer("initiate-session", annId)["session_id"] as string;
  const started = await caller;
  assert.equal(started["event"], "session_started");
  assert.equal(started["session_id"], session);
  const message = chatgpt.tool("cello_wait", { agent: "Ann", timeout_seconds: 30 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  peer("send", session, "the wake word is orange-kettle", "--over");
  assert.ok(["message", "unread"].includes((await message)["event"] as string));
  const read = await chatgpt.tool("cello_receive", { agent: "Ann" }) as { messages: { text: string }[]; commit_token?: string };
  assert.deepEqual(read.messages.map((m) => m.text), ["the wake word is orange-kettle"]);
  assert.equal(read.commit_token, undefined, "the token never reaches the model");
  const again = await chatgpt.tool("cello_receive", { agent: "Ann" }) as { messages: unknown[] };
  assert.equal(again.messages.length, 0, "a delivered read counts");
  assert.equal((await chatgpt.tool("cello_send", { agent: "Ann", session_id: session, text: "heard you", signal: "over" }))["sent"], true);
  const reply = await until("Bob reads the reply", () => {
    const got = peer("receive") as { messages: { text: string }[] };
    return got.messages.length > 0 && got.messages;
  });
  assert.equal(reply[0]?.text, "heard you");
  const quiet = await chatgpt.tool("cello_wait", { agent: "Ann", timeout_seconds: 1 });
  assert.equal(quiet["event"], "timeout");
});

test("the connection drops mid-wait: the wait ends, the hold stays, and the message is still there", async () => {
  const droppedAfter = Date.now();
  await rawCall("cello_wait", { agent: "Ann", timeout_seconds: 40 }, async (socket) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    socket.destroy();
  });
  const seen = await until("the endpoint ends the request", () => endpoint.log().split("\n").find((l) => l.includes('"tool":"cello_wait"') && l.includes('"ms":') && l.includes(`"outcome"`) && Date.parse((JSON.parse(l) as { time: string }).time) >= droppedAfter));
  assert.match(seen, /client_gone/, "the wait must still have been open when the connection dropped");
  assert.equal((await claude.tool("cello_use_agent", { agent: "Ann" }))["error"], "agent_held");
  peer("send", session, "sent while you were cut off", "--over");
  const event = await chatgpt.tool("cello_wait", { agent: "Ann", timeout_seconds: 30 });
  assert.ok(["message", "unread"].includes(event["event"] as string));
  const read = await chatgpt.tool("cello_receive", { agent: "Ann" }) as { messages: { text: string }[] };
  assert.deepEqual(read.messages.map((m) => m.text), ["sent while you were cut off"]);
});

// A reply too big for the socket buffers, to a client that stops reading and hangs up: the write never finishes.
test("a reply lost on the way out loses no message", async () => {
  const before = (endpoint.log().match(/client_gone/g) ?? []).length;
  const paragraph = "A long plain letter about the weather and the harvest, written slowly over many pages. ".repeat(12_000);
  // Too long for a command line's arguments, so straight to the peer's daemon socket.
  const bob = await IpcClient.connect(join(peerEnv["CELLO_V2_HOME"] as string, "daemon.sock"));
  for (let i = 0; i < 6; i++) await bob.call("send", { agent: "Bob", caller: "cli", session_id: session, text: `${i} ${paragraph}`, signal: "standby", est_minutes: 1 });
  bob.close();
  const ready = async (): Promise<boolean> => {
    const sessions = await chatgpt.tool("cello_sessions", { agent: "Ann" }) as { sessions: { session_id: string; unread: number }[] };
    return (sessions.sessions.find((s) => s.session_id === session)?.unread ?? 0) >= 6;
  };
  await until("six long messages screened", ready, 180_000);
  await rawCall("cello_receive", { agent: "Ann" }, async (socket) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    socket.destroy();
  });
  await until("the endpoint sees the reply never finished", () => (endpoint.log().match(/client_gone/g) ?? []).length > before);
  assert.ok(await ready(), "all six are still unread");
  const texts: string[] = [];
  // Each read is a page, and "unread" also counts what's still being screened.
  await until("all six read", async () => {
    const read = await chatgpt.tool("cello_receive", { agent: "Ann" }) as { messages: { text: string }[] };
    texts.push(...read.messages.map((m) => m.text));
    return texts.length >= 6;
  }, 120_000);
  assert.deepEqual(texts.map((t) => t[0]), ["0", "1", "2", "3", "4", "5"], "a client that reads gets each one, once");
});

test("the endpoint restarting keeps sign-ins and the hold; the daemon stopping mid-wait says so", async () => {
  await stop(endpoint);
  endpoint = await startEndpoint(PORT, ["--public-url", base]);
  assert.ok(!("error" in await chatgpt.tool("cello_agents")), "the sign-in survived");
  assert.equal((await claude.tool("cello_use_agent", { agent: "Ann" }))["error"], "agent_held");

  const waiting = chatgpt.tool("cello_wait", { agent: "Ann", timeout_seconds: 30 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const status = JSON.parse(execFileSync(process.execPath, [cliPath, "status"], { encoding: "utf8", env: ownerEnv })) as { pid: number };
  process.kill(status.pid, "SIGKILL");
  assert.equal((await waiting)["error"], "daemon_stopped_during_call");
  assert.equal((await chatgpt.tool("cello_agents"))["error"], "daemon_not_running");
  cli(ownerEnv, "login");
  await until("Ann back online", async () => (await chatgpt.tool("cello_agents") as { agents?: { name: string; online: boolean }[] }).agents?.find((a) => a.name === "Ann")?.online);
  assert.equal((await chatgpt.tool("cello_use_agent", { agent: "Ann" }))["agent_id"], annId);
  assert.equal((await claude.tool("cello_use_agent", { agent: "Ann" }))["error"], "agent_held");
});

test("force moves the agent, and ends the old holder's wait saying why", async () => {
  const waiting = chatgpt.tool("cello_wait", { agent: "Ann", timeout_seconds: 30 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await claude.tool("cello_use_agent", { agent: "Ann", force: true }))["agent_id"], annId);
  assert.equal((await waiting)["event"], "agent_displaced");
  assert.equal((await chatgpt.tool("cello_receive", { agent: "Ann" }))["error"], "agent_held");
  await claude.tool("cello_stop_using_agent", { agent: "Ann" });
  await chatgpt.tool("cello_use_agent", { agent: "Ann" });
});

test("--agents limits an endpoint by identity, in calls and in what it lists", async () => {
  limited = await startEndpoint(LIMITED_PORT, ["--agents", "Ann"]);
  const app = new App("Limited", "static", STATIC, `http://127.0.0.1:${LIMITED_PORT}/mcp`);
  assert.equal((await app.tool("cello_transcript", { agent: "Cat", session_id: session }))["error"], "agent_not_permitted");
  assert.equal((await app.tool("cello_create_agent", { name: "Dan" }))["error"], "agent_not_permitted");
  const listed = await app.tool("cello_agents") as { agents: { name: string }[] };
  assert.deepEqual(listed.agents.map((a) => a.name), ["Ann"]);
  const status = await app.tool("cello_status") as { agents: { name: string }[] };
  assert.deepEqual(status.agents.map((a) => a.name), ["Ann"]);
});

test("a close and a seal go through the endpoint", async () => {
  assert.ok(!("error" in await chatgpt.tool("cello_close_session", { agent: "Ann", session_id: session })));
  const seals = await until("a seal", async () => {
    const got = await chatgpt.tool("cello_seals", { agent: "Ann", session_id: session }) as { seals?: unknown[] };
    return (got.seals?.length ?? 0) > 0 && got.seals;
  });
  assert.ok(seals.length > 0);
  assert.ok(!endpoint.log().includes("orange-kettle"), "message text never reaches the log");
  assert.ok(!readFileSync(join(ownerEnv["CELLO_V2_HOME"] as string, "daemon.log"), "utf8").includes("orange-kettle"));
});

// Plain HTTP on a socket we control, because a client library would read the reply for us.
async function rawCall(tool: string, args: Record<string, unknown>, then: (socket: ReturnType<typeof connect>) => Promise<void>): Promise<void> {
  const headers = { authorization: `Bearer ${chatgpt.bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }) });
  await init.text();
  const sid = init.headers.get("mcp-session-id") as string;
  await (await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  const socket = connect(PORT, "127.0.0.1");
  socket.on("error", () => undefined);
  socket.write(`POST /mcp HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: ${headers.authorization}\r\ncontent-type: application/json\r\naccept: ${headers.accept}\r\nmcp-session-id: ${sid}\r\nmcp-protocol-version: 2025-06-18\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  // Never reading from it: nothing here attaches a data listener.
  await then(socket);
}
