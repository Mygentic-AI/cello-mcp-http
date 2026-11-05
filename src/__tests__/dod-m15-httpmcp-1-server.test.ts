/**
 * 082-HTTPMCP — the Streamable HTTP endpoint, end to end in-process: a REAL `startMcpHttpServer`
 * listening on a real port, the SDK's own HTTP client as the remote caller, and a fake daemon on a
 * real Unix socket (newline-delimited JSON, the IpcProxy wire). Nothing is stubbed between the
 * client and the daemon socket.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpHttpServer, type McpHttpHandle } from "../http-server.js";
import { DEFAULT_DENIED_TOOLS } from "../tool-allowlist.js";
import { readTokenFile } from "../http-config.js";
import { fakeDaemon, type Fake } from "./helpers/fake-daemon.js";

const TOKEN = "t".repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
}

let dir: string;
let fake: Fake;
let handle: McpHttpHandle | undefined;
const clients: Client[] = [];
const transports = new Map<Client, StreamableHTTPClientTransport>();
let events: Array<{ event: string; ctx: Record<string, unknown> }>;

async function boot(over: Partial<Parameters<typeof startMcpHttpServer>[0]> = {}) {
  events = [];
  handle = await startMcpHttpServer({
    socketPath: fake.path, host: "127.0.0.1", port: 0, token: TOKEN, version: "0.0.0-test",
    log: (event, ctx) => events.push({ event, ctx: ctx ?? {} }),
    ...over,
  });
  return handle;
}

async function connect(token = TOKEN): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  const t = new StreamableHTTPClientTransport(new URL(handle!.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await c.connect(t);
  clients.push(c);
  transports.set(c, t);
  return c;
}

const text = (r: unknown) => JSON.parse(((r as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, unknown>;

beforeEach(() => {
  vi.stubEnv("CELLO_DOCUMENTS", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await handle?.close().catch(() => {});
  handle = undefined;
  await fake?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "httpmcp-"));
  fake = await fakeDaemon(dir);
}

type Snap = Array<{ name: string; description?: string; inputSchema: unknown }>;
// SDK v2 labels schemas with the 2020-12 dialect where v1 said draft-07; the schema itself must match.
const dropDialect = (schema: unknown) => {
  if (schema === null || typeof schema !== "object") return schema;
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest;
};
const norm = (t: Snap) => t.map((x) => ({ name: x.name, description: x.description, inputSchema: dropDialect(x.inputSchema) })).sort((a, b) => a.name.localeCompare(b.name));




describe("082 tools allowlist over the wire", () => {
  it("a tools file limits tools/list to exactly its names", async () => {
    await setup(); await boot({ toolsFileText: "cello_agents\ncello_inbox\n" });
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["cello_agents", "cello_inbox"]);
  });




  it("an unknown tool in the file, or an empty result, fails startup", async () => {
    await setup();
    await expect(boot({ toolsFileText: "cello_nope\n" })).rejects.toMatchObject({ reason: "unknown_tool" });
    await expect(boot({ toolsFileText: "# none\n" })).rejects.toMatchObject({ reason: "tools_empty" });
  });
});

describe("082 agents allowlist over the wire", () => {
  it("startup: empty list, unknown agent fail loud; the unknown one is named with the existing agents", async () => {
    await setup();
    await expect(boot({ agents: [] })).rejects.toMatchObject({ reason: "agents_empty" });
    await expect(boot({ agents: ["alice", "zed"] })).rejects.toMatchObject({
      reason: "agent_unknown", message: expect.stringMatching(/zed[\s\S]*alice[\s\S]*bob/),
    });
  });



  it("with --agents given and the daemon unreachable, startup fails rather than starting open", async () => {
    await setup();
    await expect(boot({ agents: ["alice"], socketPath: join(dir, "absent.sock") })).rejects.toMatchObject({ reason: "daemon_unreachable" });
  });
});

describe("082 sessions (M15D: no daemon socket outlives a call unless the client holds the stream)", () => {

  it("over --max-sessions a new initialize is refused 503 only when every session is busy (a stream is open)", async () => {
    await setup(); await boot({ maxSessions: 1 });
    const headers = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = () => fetch(handle!.url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    const first = await init();
    await first.text();
    const sid = first.headers.get("mcp-session-id")!;
    const ac = new AbortController();
    await fetch(handle!.url, { method: "GET", headers: { ...headers, accept: "text/event-stream", "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" }, signal: ac.signal });
    await sleep(100);
    const res = await init();
    expect(res.status).toBe(503);
    ac.abort();
  });
});

describe("082 hardening", () => {
  it("no token / wrong token → 401 before the body is parsed (garbage body still 401, not 400)", async () => {
    await setup(); await boot();
    for (const auth of [undefined, "Bearer nope", "Basic abc"]) {
      const res = await fetch(handle!.url, {
        method: "POST",
        headers: { ...(auth ? { Authorization: auth } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: "{not json",
      });
      expect(res.status, String(auth)).toBe(401);
    }
    expect(events.some((e) => e.event === "mcp.http.auth.refused")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("GET without a token is refused too", async () => {
    await setup(); await boot();
    const res = await fetch(handle!.url, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(401);
  });

  it("refuses to start with no token, or non-loopback without TLS", async () => {
    await setup();
    await expect(boot({ token: "" })).rejects.toMatchObject({ reason: "no_token" });
    await expect(boot({ host: "0.0.0.0" })).rejects.toMatchObject({ reason: "insecure_bind" });
  });


  it("the token file must be private: group/world-readable is refused; a private one is read and trimmed", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-tok-"));
    fake = { close: async () => {} } as Fake;
    const p = join(dir, "token");
    await writeFile(p, `  ${TOKEN}\n`);
    await chmod(p, 0o644);
    expect(() => readTokenFile(p)).toThrow(/permission|readable|0600/i);
    await chmod(p, 0o600);
    expect(readTokenFile(p)).toBe(TOKEN);
  });
});
