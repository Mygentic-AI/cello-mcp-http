/**
 * M15D 002-ENDPOINT — the web endpoint as ChatGPT and Claude.ai actually use it.
 *
 * Every endpoint test here opens a FRESH MCP session per call and never sends DELETE (procedure hard
 * rule): that is what the clients do, and a test that reuses one session passes over the defect.
 * Raw HTTP, so nothing a client library does on our behalf hides a leak.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpHttpServer, type McpHttpHandle } from "../http-server.js";
import { fakeDaemon, type Fake } from "./helpers/fake-daemon.js";

const TOKEN = "t".repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LEGACY = "2025-06-18";

let dir: string;
let fake: Fake;
let handle: McpHttpHandle | undefined;
let events: Array<{ event: string; ctx: Record<string, unknown> }>;

beforeEach(async () => {
  vi.stubEnv("CELLO_DOCUMENTS", "");
  dir = await mkdtemp(join(tmpdir(), "m15d-002-"));
  fake = await fakeDaemon(dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await handle?.close().catch(() => {});
  handle = undefined;
  await fake.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function boot(over: Partial<Parameters<typeof startMcpHttpServer>[0]> = {}) {
  events = [];
  handle = await startMcpHttpServer({
    socketPath: fake.path, host: "127.0.0.1", port: 0, token: TOKEN, version: "0.0.0-test",
    log: (event, ctx) => events.push({ event, ctx: ctx ?? {} }),
    ...over,
  });
  return handle;
}

const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };

/** The JSON-RPC message in a response, whether it came back as JSON or as one SSE event. */
async function rpcBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    return JSON.parse(data[data.length - 1]!) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** ChatGPT's measured pattern: initialize → initialized → one tool call. No GET, no DELETE. */
async function legacyCall(tool: string, args: Record<string, unknown>, init: RequestInit = {}, extraHeaders: Record<string, string> = {}): Promise<{ status: number; result?: Record<string, unknown> }> {
  const initRes = await fetch(handle!.url, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "chatgpt-like", version: "0" } } }),
  });
  if (initRes.status !== 200) return { status: initRes.status };
  await initRes.text();
  const sid = initRes.headers.get("mcp-session-id")!;
  const h = { ...HEADERS, ...extraHeaders, "mcp-session-id": sid, "mcp-protocol-version": LEGACY };
  await (await fetch(handle!.url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const res = await fetch(handle!.url, {
    method: "POST", headers: h, ...init,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (res.status !== 200) return { status: res.status };
  const body = await rpcBody(res);
  const content = (body["result"] as { content?: Array<{ text: string }> } | undefined)?.content;
  return { status: 200, ...(content ? { result: JSON.parse(content[0]!.text) as Record<string, unknown> } : {}) };
}

describe("M15D 002: the endpoint under ChatGPT's per-call sessions", () => {
  it("DoD 3 — the leak test: 50 tool calls, each on a fresh initialize, none closed → at most 4 daemon sockets, no 503", async () => {
    await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) statuses.push((await legacyCall("cello_status", {})).status);
    expect(statuses.filter((s) => s !== 200), `non-200 answers: ${statuses.join(",")}`).toEqual([]);
    expect(fake.maxOpen(), "daemon sockets open at once").toBeLessThanOrEqual(4);
    await sleep(100);
    expect(fake.openNow(), "no socket outlives its call").toBe(0);
    expect(events.some((e) => e.event === "mcp.http.request" && e.ctx["kind"] === "stateless")).toBe(true);
  }, 60_000);

  it("every daemon request carries the caller from the verified token, and a forged header changes nothing", async () => {
    await boot();
    await legacyCall("cello_status", { caller: { id: "oauth:victim", label: "x" } }, {}, { "x-cello-caller": "oauth:victim" });
    const tool = fake.calls.filter((c) => c.method === "cello_status");
    expect(tool.length).toBeGreaterThan(0);
    for (const c of tool) expect(c.caller).toEqual({ id: "static", label: "static bearer" });
    expect(fake.calls.filter((c) => c.method === "ipc.connect").every((c) => c.params?.["clientType"] === "endpoint")).toBe(true);
  });

  it("cello_receive is committed only after the response is written, and the token never reaches the model", async () => {
    fake.respond = (m) => (m === "cello_receive" ? { ok: true, count: 1, messages: [{ text: "hi" }], commit: "tok-1" } : undefined);
    await boot();
    const r = await legacyCall("cello_receive", { cello_session_id: "s1", agent: "alice" });
    expect(r.result?.["messages"]).toEqual([{ text: "hi" }]);
    expect("commit" in (r.result ?? {})).toBe(false);
    await sleep(200);
    expect(fake.calls.filter((c) => c.method === "session.receive.commit").map((c) => c.params?.["token"])).toEqual(["tok-1"]);
  });

  it("a caller that hangs up mid-receive closes the daemon socket and commits nothing", async () => {
    let receiveConn = 0;
    fake.respond = async (m, _p, conn) => {
      if (m !== "cello_receive") return undefined;
      receiveConn = conn;
      await sleep(1500);
      return { ok: true, count: 1, messages: [{ text: "late" }], commit: "tok-late" };
    };
    await boot();
    const ac = new AbortController();
    const pending = legacyCall("cello_receive", { cello_session_id: "s1", agent: "alice" }, { signal: ac.signal }).catch(() => ({ status: 0 }));
    await sleep(300);
    ac.abort();
    await pending;
    await sleep(300);
    expect(receiveConn).toBeGreaterThan(0);
    expect(fake.closedConns.has(receiveConn), "the daemon socket of the abandoned call is closed").toBe(true);
    await sleep(1500);
    expect(fake.calls.filter((c) => c.method === "session.receive.commit")).toEqual([]);
  });

  it("the four previously hidden tools are exposed", async () => {
    await boot();
    const res = await legacyCall("cello_settings_set", { key: "x", value: "y" });
    expect(res.status).toBe(200);
    expect(res.result?.["reason"]).not.toBe("tool_not_permitted");
  });
});

describe("M15D 002: stream sessions keep notifications", () => {
  it("a GET stream holds one daemon socket, forwards a doorbell, and frees it when the stream closes", async () => {
    await boot();
    const initRes = await fetch(handle!.url, {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "codex-like", version: "0" } } }),
    });
    await initRes.text();
    const sid = initRes.headers.get("mcp-session-id")!;
    const h = { ...HEADERS, "mcp-session-id": sid, "mcp-protocol-version": LEGACY };
    await (await fetch(handle!.url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
    const before = fake.openNow();
    const ac = new AbortController();
    const stream = await fetch(handle!.url, { method: "GET", headers: { ...h, accept: "text/event-stream" }, signal: ac.signal });
    expect(stream.status).toBe(200);
    await sleep(200);
    expect(fake.openNow(), "the stream holds one daemon socket").toBe(before + 1);
    const streamConn = fake.calls.filter((c) => c.method === "ipc.connect").at(-1)!.conn;
    fake.push(streamConn, { notification: "cello_message", data: { agent: "alice", type: "cello_message", from: "bb".repeat(32), session_id: "s1" } });
    const reader = stream.body!.getReader();
    let got = "";
    const deadline = Date.now() + 2000;
    while (!got.includes("notifications/claude/channel") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      got += new TextDecoder().decode(value);
    }
    expect(got).toContain("notifications/claude/channel");
    ac.abort();
    await sleep(300);
    expect(fake.closedConns.has(streamConn), "closing the stream frees its daemon socket").toBe(true);
  });

  it("a session with no stream and no call is closed after the idle limit; its id then answers 404", async () => {
    await boot({ streamIdleMs: 200 });
    const initRes = await fetch(handle!.url, {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    await initRes.text();
    const sid = initRes.headers.get("mcp-session-id")!;
    await sleep(500);
    const res = await fetch(handle!.url, {
      method: "POST", headers: { ...HEADERS, "mcp-session-id": sid, "mcp-protocol-version": LEGACY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("when the session table is full the oldest idle session is evicted, not the new one refused", async () => {
    await boot({ maxSessions: 3 });
    const sids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(handle!.url, {
        method: "POST", headers: HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
      });
      expect(r.status).toBe(200);
      await r.text();
      sids.push(r.headers.get("mcp-session-id")!);
      await sleep(20);
    }
    const oldest = await fetch(handle!.url, {
      method: "POST", headers: { ...HEADERS, "mcp-session-id": sids[0]!, "mcp-protocol-version": LEGACY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(oldest.status).toBe(404);
    expect(events.some((e) => e.event === "mcp.http.session.evicted")).toBe(true);
  });
});
