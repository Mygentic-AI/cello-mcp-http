/**
 * The CELLO MCP tools over Streamable HTTP, in front of the operator's OWN local daemon.
 *
 * An adapter, not a node: it holds a socket path and a bearer token, nothing else. Served on MCP SDK
 * v2: 2026-07-28 requests are self-contained and get a fresh server each; 2025-era clients keep a
 * session, but no daemon socket outlives a tool call. Every daemon request carries the caller from the verified token, which is what the
 * daemon's one-holder-per-agent rule keys on. Two allowlists bound what a caller reaches — which tools are declared on the server
 * (an excluded tool does not exist on it) and which agents a tool argument may name (checked here,
 * before the daemon is called). The allowlists constrain THIS endpoint; any local process that can
 * open the daemon socket is unaffected.
 */

import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { McpServer as McpServerV2, createMcpHandler, isLegacyRequest, isInitializeRequest, type AuthInfo } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { DaemonRoute, requestScope, type Caller, type RequestScope } from "./call-proxy.js";
import { logEvent, type LogFn } from "./log.js";
import { McpHttpConfigError, isLoopbackHost } from "./http-config.js";
import { ToolsFileError, collectToolNames, registerTools, resolveAllowedTools } from "./tool-allowlist.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { AgentGuardError, guardProxy, resolvePermittedAgents } from "./agent-guard.js";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { CelloOAuthProvider } from "./oauth-provider.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const STATIC_CALLER: Caller = { id: "static", label: "static bearer" };

export interface McpHttpOptions {
  socketPath: string;
  host: string;
  port: number;
  token: string;
  version: string;
  /** Names or pubkeys. Undefined = serve every agent the daemon has. */
  agents?: string[];
  /** Contents of the tools file. Undefined = every tool except DEFAULT_DENIED_TOOLS. */
  toolsFileText?: string;
  tls?: { cert: string; key: string };
  /**
   * OAuth for clients that can only be given a URL (the Claude app). `publicUrl` is the address clients
   * use (e.g. the Tailscale Funnel URL), since behind a tunnel this process only sees 127.0.0.1. `stateDir`
   * holds the pairing code and the hashed tokens. Undefined = static bearer token only.
   */
  oauth?: { publicUrl: string; stateDir: string; codeUrl?: string };
  maxSessions?: number;
  /** Close a 2025-era session with no open stream and no call in flight after this long (default 120 s). */
  streamIdleMs?: number;
  log?: LogFn;
}

export interface McpHttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}


const digest = (s: string) => createHash("sha256").update(s).digest();

function bearerOf(header: string | undefined): string | undefined {
  return header !== undefined && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return "too_large";
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpHandle> {
  const log: LogFn = opts.log ?? logEvent;
  const maxSessions = opts.maxSessions ?? 16;
  const streamIdleMs = opts.streamIdleMs ?? 120_000;

  if (opts.token === "") {
    throw new McpHttpConfigError("no_token", "no bearer token configured; pass --token-file or set CELLO_MCP_HTTP_TOKEN. An endpoint with no token would be open to anyone who can reach it.");
  }
  if (!isLoopbackHost(opts.host) && opts.tls === undefined) {
    throw new McpHttpConfigError("insecure_bind", `refusing to listen on ${opts.host} without TLS; pass --tls-cert/--tls-key, or bind to 127.0.0.1 and put your own TLS in front.`);
  }

  const allNames = collectToolNames();
  let allowed: Set<string>;
  try {
    allowed = resolveAllowedTools(allNames, opts.toolsFileText);
  } catch (e) {
    if (e instanceof ToolsFileError) {
      throw new McpHttpConfigError(e.reason === "empty_set" ? "tools_empty" : "unknown_tool", e.message);
    }
    throw e;
  }
  const excluded = new Set(allNames.filter((n) => !allowed.has(n)));

  const route = new DaemonRoute(opts.socketPath, log);
  let permitted: ReadonlySet<string> | "all" = "all";
  if (opts.agents !== undefined) {
    try {
      permitted = await resolvePermittedAgents(route.proxy(), opts.agents);
    } catch (e) {
      if (e instanceof AgentGuardError) throw new McpHttpConfigError(e.reason, e.message);
      throw new McpHttpConfigError("daemon_unreachable", `cannot reach the CELLO daemon at ${opts.socketPath} to check --agents: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let provider: CelloOAuthProvider | undefined;
  let resourceMetadataUrl: string | undefined;
  let publicBase: URL | undefined;
  if (opts.oauth !== undefined) {
    publicBase = new URL(opts.oauth.publicUrl.replace(/\/+$/, "") + "/");
    if (publicBase.pathname !== "/") throw new McpHttpConfigError("bad_public_url", `--public-url must be an origin with no path, like https://host.example; got ${opts.oauth.publicUrl}`);
    const loopback = publicBase.hostname === "localhost" || publicBase.hostname === "127.0.0.1";
    if (publicBase.protocol !== "https:" && !loopback) throw new McpHttpConfigError("bad_public_url", `--public-url must be https (tokens travel on it); got ${opts.oauth.publicUrl}`);
    provider = new CelloOAuthProvider(opts.oauth.stateDir, log, opts.oauth.codeUrl);
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(MCP_PATH, publicBase));
  }

  /** The static token, or (with OAuth on) a live access token issued by this endpoint. */
  /**
   * Who is calling, from the verified token and nothing else: `oauth:<clientId>` with the registered
   * client's name as the label, or `static` for the endpoint's own bearer. Null when unverified.
   */
  async function authorized(header: string | undefined): Promise<Caller | null> {
    const presented = bearerOf(header);
    if (presented === undefined) return null;
    if (timingSafeEqual(digest(presented), digest(opts.token))) return STATIC_CALLER;
    if (provider === undefined) return null;
    try {
      const info = await provider.verifyAccessToken(presented);
      // A token minted for another resource is not a token for this one.
      if (info.resource !== undefined && info.resource.href !== new URL(MCP_PATH, publicBase).href) return null;
      const client = await provider.clientsStore.getClient(info.clientId);
      return { id: `oauth:${info.clientId}`, label: client?.client_name ?? info.clientId };
    } catch {
      return null;
    }
  }
  // The modern handler hands the factory the AuthInfo we set on the request; the caller rides in it.
  const authInfoOf = (caller: Caller): AuthInfo => ({ token: "verified", clientId: caller.id, scopes: [], extra: { caller } });
  const callerOf = (info: AuthInfo | undefined): Caller => {
    const c = info?.extra?.["caller"] as Caller | undefined;
    if (!c) throw new Error("modern request reached the server factory without a verified caller");
    return c;
  };

  /**
   * 2025-era (pre-2026-07-28) sessions. A session holds no daemon socket: each tool call opens one
   * and closes it (`call-proxy.ts`). A GET stream stays open if a client wants one, and nothing is pushed on it.
   * A session with no stream and no call in flight is closed after `streamIdleMs`; when the table is
   * full the oldest idle session is evicted instead of the new one refused.
   */
  interface LegacySession {
    id: string | undefined;
    transport: NodeStreamableHTTPServerTransport;
    server: McpServerV2;
    caller: Caller;
    lastUsed: number;
    inFlight: number;
    streamOpen: boolean;
    closed: boolean;
  }
  const sessions = new Map<string, LegacySession>();
  let starting = 0;

  const closeSession = (s: LegacySession, why: string): void => {
    if (s.closed) return;
    s.closed = true;
    if (s.id !== undefined) sessions.delete(s.id);
    s.streamOpen = false;
    void s.transport.close().catch(() => {});
    s.server.close().catch((e: unknown) => log("mcp.http.session.close_failed", { sessionId: s.id, error: e instanceof Error ? e.message : String(e) }));
    log("mcp.http.session.closed", { sessionId: s.id, why });
  };

  const idle = (s: LegacySession): boolean => !s.streamOpen && s.inFlight === 0;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) if (idle(s) && now - s.lastUsed > streamIdleMs) closeSession(s, "idle");
  }, Math.max(50, Math.min(30_000, Math.floor(streamIdleMs / 2))));
  sweeper.unref();

  /** Make room for one more session, or say there is none (every session has a call or a stream). */
  function makeRoom(): boolean {
    if (sessions.size + starting < maxSessions) return true;
    const oldest = [...sessions.values()].filter(idle).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!oldest) return false;
    log("mcp.http.session.evicted", { sessionId: oldest.id, idleMs: Date.now() - oldest.lastUsed });
    closeSession(oldest, "evicted");
    return true;
  }

  /** One server, for one caller: the same tool list either era serves. */
  function buildServer(caller: Caller): McpServerV2 {
    const server = new McpServerV2(
      { name: "cello", version: opts.version },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(server, allowed, guardProxy(route.proxy(), permitted, log), caller);
    return server;
  }

  async function newLegacySession(caller: Caller): Promise<LegacySession> {
    const server = buildServer(caller);
    const s: LegacySession = {
      id: undefined, transport: undefined as unknown as NodeStreamableHTTPServerTransport, server, caller,
      lastUsed: Date.now(), inFlight: 0, streamOpen: false, closed: false,
    };
    s.transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        s.id = sid;
        sessions.set(sid, s);
        log("mcp.http.session.opened", { sessionId: sid, sessions: sessions.size, caller: caller.label });
      },
    });
    s.transport.onclose = () => closeSession(s, "transport_closed");
    await server.connect(s.transport);
    // An excluded tool is not declared, but a client may still call it by name. Answer it here with
    // the operator's reason, before the SDK's generic "not found", and never reach the daemon.
    const inner = s.transport.onmessage;
    s.transport.onmessage = (msg, extra) => {
      const m = msg as { id?: string | number; method?: string; params?: { name?: unknown } };
      if (m.method === "tools/call" && m.id !== undefined && typeof m.params?.name === "string" && excluded.has(m.params.name)) {
        log("mcp.http.tool.refused", { tool: m.params.name, sessionId: s.id });
        const refusal = {
          error: "tool_not_permitted",
          message: `${m.params.name} is not exposed by this endpoint; its operator excluded it at startup and it cannot be enabled from here. Use one of the tools listed by tools/list.`,
        };
        void s.transport.send(
          { jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(refusal) }] } },
          { relatedRequestId: m.id },
        );
        return;
      }
      inner?.(msg, extra);
    };
    return s;
  }

  /** Run one HTTP exchange in its own request scope: hang-up aborts it, a written response commits. */
  async function inScope(caller: Caller, res: ServerResponse, record: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
    const started = Date.now();
    const ac = new AbortController();
    const scope: RequestScope = { signal: ac.signal, commits: [] };
    let finished = false;
    res.on("finish", () => {
      finished = true;
      route.commit(caller, scope.commits);
    });
    res.on("close", () => {
      if (!finished) ac.abort();
      log("mcp.http.request", {
        ts: new Date(started).toISOString(), ...record, caller_label: caller.label,
        ms: Date.now() - started, outcome: finished ? `http_${res.statusCode}` : "client_gone",
      });
    });
    await requestScope.run(scope, run);
  }

  const modern = toNodeHandler(createMcpHandler((ctx) => buildServer(callerOf(ctx.authInfo)), { legacy: "reject" }));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const caller = await authorized(req.headers["authorization"]);
    if (caller === null) {
      log("mcp.http.auth.refused", { method: req.method, path: new URL(req.url ?? "/", "http://x").pathname, bearer: req.headers["authorization"] !== undefined, remote: req.socket.remoteAddress });
      const challenge = resourceMetadataUrl === undefined ? "Bearer" : `Bearer resource_metadata="${resourceMetadataUrl}"`;
      const guidance = provider === undefined
        ? "Send the endpoint's bearer token as `Authorization: Bearer <token>`."
        : "Send the endpoint's bearer token, or sign in with OAuth (see the resource_metadata in WWW-Authenticate).";
      send(res, 401, { ok: false, reason: "unauthorized", guidance }, { "www-authenticate": challenge });
      return;
    }
    if (new URL(req.url ?? "/", "http://x").pathname !== MCP_PATH) {
      send(res, 404, { ok: false, reason: "not_found", guidance: `The MCP endpoint is ${MCP_PATH}.` });
      return;
    }

    let parsed: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw === "too_large") {
        send(res, 413, { ok: false, reason: "body_too_large", guidance: `Request bodies are limited to ${MAX_BODY_BYTES} bytes.` });
        return;
      }
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(res, 400, { ok: false, reason: "bad_json", guidance: "The request body is not valid JSON." });
        return;
      }
    }
    const rpc = parsed as { method?: string; params?: { name?: unknown } } | undefined;
    const record = { method: rpc?.method ?? req.method, ...(rpc?.method === "tools/call" && typeof rpc.params?.name === "string" ? { tool: rpc.params.name } : {}) };

    // 2026-07-28: every request is self-contained. Served by a fresh server per request.
    if (!(await isLegacyRequest(await toWebRequest(req, parsed), parsed))) {
      (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfoOf(caller);
      await inScope(caller, res, { era: "modern", kind: "stateless", ...record }, () => modern(req, res, parsed));
      return;
    }

    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    const known = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (sessionId !== undefined && (!known || known.caller.id !== caller.id)) {
      // Unknown, expired, or someone else's: the client re-initialises.
      send(res, 404, { ok: false, reason: "unknown_session", guidance: "That MCP session has ended or never existed; send a new initialize request." });
      return;
    }

    if (req.method === "POST") {
      let s = known;
      if (!s) {
        if (!isInitializeRequest(parsed)) {
          send(res, 400, { ok: false, reason: "no_session", guidance: "Start with an initialize request; later requests carry the Mcp-Session-Id it returns." });
          return;
        }
        if (!makeRoom()) {
          send(res, 503, { ok: false, reason: "too_many_sessions", guidance: `All ${maxSessions} sessions of this endpoint are busy (each has a call or a stream open); retry shortly.` });
          return;
        }
        starting++;
        try {
          s = await newLegacySession(caller);
        } finally {
          starting--;
        }
      }
      const session = s;
      session.inFlight++;
      session.lastUsed = Date.now();
      res.on("close", () => { session.inFlight--; session.lastUsed = Date.now(); });
      await inScope(caller, res, { era: "legacy", kind: session.streamOpen ? "stream" : "stateless", ...record }, () => session.transport.handleRequest(req, res, parsed));
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!known) {
        send(res, 400, { ok: false, reason: "no_session", guidance: "Send the Mcp-Session-Id returned by initialize." });
        return;
      }
      known.lastUsed = Date.now();
      if (req.method === "GET") {
        known.streamOpen = true;
        res.on("close", () => { known.streamOpen = false; known.lastUsed = Date.now(); });
        await known.transport.handleRequest(req, res);
        return;
      }
      await known.transport.handleRequest(req, res);
      closeSession(known, "deleted");
      return;
    }
    send(res, 405, { ok: false, reason: "method_not_allowed", guidance: "Use POST, GET or DELETE." }, { allow: "POST, GET, DELETE" });
  }

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      log("mcp.http.request.failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(res, 500, { ok: false, reason: "internal_error", guidance: "The endpoint failed handling this request; see its log." });
      else res.end();
    });
  };
  let root: (req: IncomingMessage, res: ServerResponse) => void = listener;
  if (provider !== undefined && publicBase !== undefined) {
    const app = express();
    // Behind a local tunnel (Tailscale Funnel) the only proxy is on loopback; trust it for client addresses.
    app.set("trust proxy", "loopback");
    app.use(mcpAuthRouter({ provider, issuerUrl: publicBase, resourceServerUrl: new URL(MCP_PATH, publicBase), resourceName: "CELLO" }));
    const p = provider;
    app.post("/authorize/approve", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
      p.approve(req, res).catch((err: unknown) => {
        log("mcp.http.oauth.approve.failed", { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) res.status(500).type("text").send("The endpoint failed handling this approval; see its log.");
      });
    });
    app.use((req, res) => listener(req, res));
    root = app;
  }
  const httpServer: Server = opts.tls ? createHttps({ cert: opts.tls.cert, key: opts.tls.key }, root) : createHttp(root);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const url = `${opts.tls ? "https" : "http"}://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${port}${MCP_PATH}`;
  log("mcp.http.listening", {
    url,
    tls: opts.tls !== undefined,
    agents: permitted === "all" ? "all" : permitted.size,
    toolsAllowed: allowed.size,
    toolsExcluded: excluded.size,
    oauth: publicBase?.origin ?? false,
  });

  return {
    url,
    port,
    async close() {
      clearInterval(sweeper);
      for (const s of [...sessions.values()]) closeSession(s, "shutdown");
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
