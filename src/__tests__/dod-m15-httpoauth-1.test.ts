/**
 * 083-HTTPOAUTH — a client that can only be given a URL (the Claude app) signs in to the operator's own
 * endpoint. The endpoint is its own OAuth authorization server; the operator approves by typing a one-time
 * pairing code that only someone at the machine can read.
 *
 * Driven over real HTTP against a real startMcpHttpServer and a fake daemon socket, the way a client would.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer, type McpHttpHandle } from "../http-server.js";
import { createPairingCode } from "../pairing.js";
import { revokeTokens } from "../oauth-store.js";
import { fakeDaemon, type Fake } from "./helpers/fake-daemon.js";

const STATIC = "s".repeat(40);
const REDIRECT = "https://claude.example/api/mcp/auth_callback";

let dir: string;
let stateDir: string;
let fake: Fake;
let handle: McpHttpHandle | undefined;
let base: string;
const clients: Client[] = [];

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => r(p));
    });
  });
}

beforeEach(async () => {
  vi.stubEnv("CELLO_DOCUMENTS", "");
  dir = await mkdtemp(join(tmpdir(), "httpoauth-"));
  stateDir = join(dir, "mcp-http");
  fake = await fakeDaemon(dir);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  handle = await startMcpHttpServer({
    socketPath: fake.path, host: "127.0.0.1", port, token: STATIC, version: "0.0.0-test",
    toolsFileText: "cello_agents\ncello_inbox\n",
    oauth: { publicUrl: base, stateDir },
    log: () => {},
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await handle?.close().catch(() => {});
  handle = undefined;
  await fake?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const b64url = (b: Buffer) => b.toString("base64url");

async function register(): Promise<{ client_id: string; client_secret?: string }> {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string };
}

/** Opens the authorize page and returns the pending-request id the form carries, plus the PKCE verifier. */
async function openAuthorize(clientId: string, state = "st-1"): Promise<{ request: string; verifier: string; html: string }> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state, resource: `${base}/mcp` });
  const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  expect(r.status).toBe(200);
  const html = await r.text();
  const m = /name="request" value="([^"]+)"/.exec(html);
  expect(m?.[1]).toBeDefined();
  return { request: m![1]!, verifier, html };
}

async function approve(request: string, code: string): Promise<Response> {
  return fetch(`${base}/authorize/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, code }).toString(),
    redirect: "manual",
  });
}

async function token(body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
}

async function signIn(): Promise<{ clientId: string; access: string; refresh: string }> {
  const { client_id } = await register();
  const { request, verifier } = await openAuthorize(client_id);
  const code = await createPairingCode(stateDir);
  const r = await approve(request, code);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st-1");
  const t = await token({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, code_verifier: verifier, client_id, redirect_uri: REDIRECT });
  expect(t.status).toBe(200);
  const j = (await t.json()) as { access_token: string; refresh_token: string; token_type: string };
  expect(j.token_type.toLowerCase()).toBe("bearer");
  return { clientId: client_id, access: j.access_token, refresh: j.refresh_token };
}

async function mcpWith(bearer: string): Promise<Client> {
  const c = new Client({ name: "oauth-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  clients.push(c);
  return c;
}

describe("O1 discovery", () => {
  it("an unauthenticated /mcp request is told where the OAuth metadata is", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("both well-known documents name the public URLs", async () => {
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(`${base}/mcp`);
    expect(prm.authorization_servers).toEqual([`${base}/`]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
    expect(as.authorization_endpoint).toBe(`${base}/authorize`);
    expect(as.token_endpoint).toBe(`${base}/token`);
    expect(as.registration_endpoint).toBe(`${base}/register`);
  });
});

describe("O2 full flow", () => {
  it("register, authorize, pair, approve, exchange, then call tools with the access token", async () => {
    const { access } = await signIn();
    const c = await mcpWith(access);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["cello_agents", "cello_inbox"]);
    const r = await c.callTool({ name: "cello_agents", arguments: {} });
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toEqual({ agents: fake.roster });
  });

  it("the page asks for the pairing code and names the command that prints it", async () => {
    const { client_id } = await register();
    const { html } = await openAuthorize(client_id);
    expect(html).toContain('name="code"');
    expect(html).toContain("cello-mcp-http pair");
    expect(html).toContain("Claude");
  });

  it("the static token still works beside OAuth", async () => {
    const c = await mcpWith(STATIC);
    expect((await c.listTools()).tools.length).toBe(2);
  });
});

describe("O3 pairing code", () => {
  it("a wrong code is refused and redirects nowhere", async () => {
    const { client_id } = await register();
    const { request } = await openAuthorize(client_id);
    await createPairingCode(stateDir);
    const r = await approve(request, "WRONG-CODE");
    expect(r.status).toBe(401);
    expect(r.headers.get("location")).toBeNull();
  });

  it("a code works once", async () => {
    const { client_id } = await register();
    const code = await createPairingCode(stateDir);
    const first = await openAuthorize(client_id, "a");
    expect((await approve(first.request, code)).status).toBe(302);
    const second = await openAuthorize(client_id, "b");
    expect((await approve(second.request, code)).status).toBe(401);
  });

  it("an expired code is refused", async () => {
    const { client_id } = await register();
    const { request } = await openAuthorize(client_id);
    const code = await createPairingCode(stateDir, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect((await approve(request, code)).status).toBe(401);
  });

  it("the fifth wrong attempt burns the code", async () => {
    const { client_id } = await register();
    const { request } = await openAuthorize(client_id);
    const code = await createPairingCode(stateDir);
    for (let i = 0; i < 5; i++) expect((await approve(request, `bad-${i}`)).status).toBe(401);
    expect((await approve(request, code)).status).toBe(401);
  });

  it("with no code ever issued, approval is refused", async () => {
    const { client_id } = await register();
    const { request } = await openAuthorize(client_id);
    expect((await approve(request, "anything")).status).toBe(401);
  });
});

describe("O4 tampering", () => {
  it("an approve for an unknown pending request fails", async () => {
    const code = await createPairingCode(stateDir);
    expect((await approve("not-a-request", code)).status).toBe(400);
  });

  it("the wrong PKCE verifier cannot exchange the code", async () => {
    const { client_id } = await register();
    const { request } = await openAuthorize(client_id);
    const r = await approve(request, await createPairingCode(stateDir));
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const t = await token({ grant_type: "authorization_code", code, code_verifier: b64url(randomBytes(32)), client_id, redirect_uri: REDIRECT });
    expect(t.status).toBe(400);
  });

  it("an authorization code works once", async () => {
    const { client_id } = await register();
    const { request, verifier } = await openAuthorize(client_id);
    const r = await approve(request, await createPairingCode(stateDir));
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const body = { grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT };
    expect((await token(body)).status).toBe(200);
    expect((await token(body)).status).toBe(400);
  });

  const post = (bearer: string) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: "{}" });

  it("a made-up access token is refused, including while a real one is live", async () => {
    expect((await post("made-up")).status).toBe(401);
    await signIn();
    expect((await post("made-up")).status).toBe(401);
  });

  it("a refresh token is not an access token", async () => {
    const { refresh } = await signIn();
    expect((await post(refresh)).status).toBe(401);
  });

  it("an expired access token is refused", async () => {
    const { access } = await signIn();
    const { updateState } = await import("../oauth-store.js");
    await updateState(stateDir, (s) => { for (const t of s.tokens) if (t.kind === "access") t.expiresAt = Date.now() + 30; });
    await new Promise((r) => setTimeout(r, 60));
    expect((await post(access)).status).toBe(401);
  });
});

describe("O5 refresh", () => {
  it("rotates, and the old refresh token then fails", async () => {
    const { clientId, refresh } = await signIn();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
    expect(r1.status).toBe(200);
    const j = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(j.refresh_token).not.toBe(refresh);
    const c = await mcpWith(j.access_token);
    expect((await c.listTools()).tools.length).toBe(2);
    expect((await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).status).toBe(400);
  });
});

describe("O6 revoke", () => {
  it("after revoke, the access token is refused on the next request", async () => {
    const { access } = await signIn();
    const ping = () => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }) });
    expect((await ping()).status).toBe(200);
    const n = await revokeTokens(stateDir);
    expect(n).toBeGreaterThan(0);
    expect((await ping()).status).toBe(401);
  });
});

describe("O7 at rest", () => {
  it("state files are 0600 and hold no raw token or pairing code", async () => {
    const code = await createPairingCode(stateDir);
    const pairingText = await readFile(join(stateDir, "pairing"), "utf8");
    expect(pairingText).not.toContain(code);
    expect((await stat(join(stateDir, "pairing"))).mode & 0o777).toBe(0o600);

    const { access, refresh } = await signIn();
    const oauthText = await readFile(join(stateDir, "oauth.json"), "utf8");
    expect(oauthText).not.toContain(access);
    expect(oauthText).not.toContain(refresh);
    expect((await stat(join(stateDir, "oauth.json"))).mode & 0o777).toBe(0o600);
  });
});
