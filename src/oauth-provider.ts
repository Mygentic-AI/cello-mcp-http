/**
 * The endpoint as its own OAuth 2.1 authorization server, for clients that can only be given a URL.
 *
 * The MCP SDK's router handles metadata, dynamic registration, PKCE and the token endpoint; this provider
 * supplies the one decision that matters: a client is approved only when someone types the pairing code
 * that `cello-mcp-http pair` printed at the operator's machine. The consent page carries no authority —
 * the pending request lives here, keyed by a random id, and the page posts back only that id and the code.
 */
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, TooManyRequestsError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { LogFn } from "@cello-protocol/connect/lib";
import { loadState, tokenHash, updateState } from "./oauth-store.js";
import { consumePairingCode } from "./pairing.js";

export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
/** Registration is open to the internet; this bounds what a flood of it can store. */
export const MAX_CLIENTS = 100;
const UNUSED_CLIENT_TTL_S = 60 * 60;

interface Pending { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number }
interface AuthCode { clientId: string; challenge: string; redirectUri: string; scopes: string[]; resource?: string; expiresAt: number }

const secret = () => randomBytes(32).toString("base64url");

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}input{background:#222;color:#eee;border-color:#555}}
code{background:rgba(127,127,127,.15);padding:.1rem .3rem;border-radius:4px}
input{font-size:1.4rem;letter-spacing:.15em;padding:.5rem;width:100%;box-sizing:border-box;text-transform:uppercase;border:1px solid #bbb;border-radius:6px}
button{margin-top:1rem;font-size:1rem;padding:.6rem 1.2rem;border-radius:6px;border:0;background:#2b5cd6;color:#fff;cursor:pointer}
.err{color:#c0392b}</style></head><body>${body}</body></html>`;
}

export class CelloOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, AuthCode>();
  /** Requests already approved, so a second submit of the same form (a double click, a browser resend) is not reported as expired. */
  private readonly approved = new Map<string, number>();

  constructor(private readonly stateDir: string, private readonly log: LogFn) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const stateDir = this.stateDir;
    const log = this.log;
    return {
      async getClient(clientId: string) {
        return (await loadState(stateDir)).clients[clientId];
      },
      async registerClient(client: OAuthClientInformationFull) {
        await updateState(stateDir, (s) => {
          const nowS = Math.floor(Date.now() / 1000);
          const holders = new Set(s.tokens.map((t) => t.clientId));
          for (const [id, c] of Object.entries(s.clients)) {
            if (!holders.has(id) && (c.client_id_issued_at ?? 0) < nowS - UNUSED_CLIENT_TTL_S) delete s.clients[id];
          }
          if (Object.keys(s.clients).length >= MAX_CLIENTS) throw new TooManyRequestsError("too many registered clients; revoke unused ones with cello-mcp-http revoke");
          s.clients[client.client_id] = client;
        });
        log("mcp.http.oauth.client.registered", { clientId: client.client_id, name: client.client_name });
        return client;
      },
    } as OAuthRegisteredClientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = await this.openPending(client, params);
    this.log("mcp.http.oauth.authorize.opened", { clientId: client.client_id });
    res.status(200).type("html").send(this.consentPage(id, client));
  }

  /** Records an authorization request server-side; the page only ever carries this id. */
  async openPending(client: OAuthClientInformationFull, params: AuthorizationParams = { codeChallenge: "", redirectUri: client.redirect_uris[0] ?? "" }): Promise<string> {
    this.prune();
    const id = secret();
    this.pending.set(id, { client, params, expiresAt: Date.now() + PENDING_TTL_MS });
    return id;
  }

  private consentPage(id: string, client: OAuthClientInformationFull, error?: string): string {
    const name = client.client_name ?? "An app";
    return page("Connect to CELLO", `
<h1>Connect ${esc(name)} to your CELLO agents?</h1>
<p><strong>${esc(name)}</strong> is asking to use this CELLO endpoint. It will reach only the agents and tools
this endpoint's operator allowed.</p>
<p>To approve, run this on the machine where CELLO runs, and type the code it prints:</p>
<p><code>cello-mcp-http pair</code></p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize/approve">
<input type="hidden" name="request" value="${esc(id)}">
<input name="code" autocomplete="one-time-code" autofocus required placeholder="XXXX-XXXX" aria-label="Pairing code">
<button type="submit">Approve</button>
</form>
<p>If you did not start this, close this page. Nothing is shared until the code is entered.</p>`);
  }

  /** POST /authorize/approve — the only place a client is granted access. */
  async approve(req: Request, res: Response): Promise<void> {
    this.prune();
    const body = (req.body ?? {}) as { request?: unknown; code?: unknown };
    const id = typeof body.request === "string" ? body.request : "";
    const p = this.pending.get(id);
    if (!p && this.approved.has(id)) {
      res.status(200).type("html").send(page("Already approved", "<h1>Already approved</h1><p>This sign-in was approved. Return to the app; you can close this page.</p>"));
      return;
    }
    if (!p) {
      res.status(400).type("html").send(page("Request expired", "<h1>This request has expired</h1><p>Go back to the app and start connecting again.</p>"));
      return;
    }
    const code = typeof body.code === "string" ? body.code : "";
    const { result, attemptsLeft } = await consumePairingCode(this.stateDir, code);
    if (result !== "ok") {
      this.log("mcp.http.oauth.pairing.refused", { clientId: p.client.client_id, result, attemptsLeft });
      // One message for every failure, so the page does not tell a guesser when a code is live.
      const why = "That code did not work. Run cello-mcp-http pair for a fresh code and try again.";
      res.status(401).type("html").send(this.consentPage(id, p.client, why));
      return;
    }
    this.pending.delete(id);
    this.approved.set(id, Date.now() + PENDING_TTL_MS);
    const authCode = secret();
    this.codes.set(authCode, {
      clientId: p.client.client_id,
      challenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      scopes: p.params.scopes ?? [],
      resource: p.params.resource?.href,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.log("mcp.http.oauth.client.approved", { clientId: p.client.client_id, name: p.client.client_name });
    const target = new URL(p.params.redirectUri);
    target.searchParams.set("code", authCode);
    if (p.params.state !== undefined) target.searchParams.set("state", p.params.state);
    res.redirect(302, target.href);
  }

  private liveCode(client: OAuthClientInformationFull, authorizationCode: string): AuthCode {
    const c = this.codes.get(authorizationCode);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("invalid or expired authorization code");
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.liveCode(client, authorizationCode).challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.liveCode(client, authorizationCode);
    this.codes.delete(authorizationCode);
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    return this.issue(client.client_id, c.scopes, c.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const h = tokenHash(refreshToken);
    const now = Date.now();
    const old = await updateState(this.stateDir, (s) => {
      const i = s.tokens.findIndex((t) => t.kind === "refresh" && t.hash === h && t.clientId === client.client_id && t.expiresAt > now);
      if (i === -1) return undefined;
      return s.tokens.splice(i, 1)[0];
    });
    if (!old) throw new InvalidGrantError("invalid or expired refresh token");
    return this.issue(client.client_id, old.scopes, old.resource);
  }

  private async issue(clientId: string, scopes: string[], resource: string | undefined): Promise<OAuthTokens> {
    const access = secret();
    const refresh = secret();
    const now = Date.now();
    await updateState(this.stateDir, (s) => {
      s.tokens.push({ hash: tokenHash(access), kind: "access", clientId, scopes, resource, expiresAt: now + ACCESS_TTL_MS });
      s.tokens.push({ hash: tokenHash(refresh), kind: "refresh", clientId, scopes, resource, expiresAt: now + REFRESH_TTL_MS });
    });
    this.log("mcp.http.oauth.token.issued", { clientId });
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const h = tokenHash(token);
    const t = (await loadState(this.stateDir)).tokens.find((x) => x.kind === "access" && x.hash === h && x.expiresAt > Date.now());
    if (!t) throw new InvalidTokenError("invalid, expired or revoked access token");
    return { token, clientId: t.clientId, scopes: t.scopes, expiresAt: Math.floor(t.expiresAt / 1000), resource: t.resource ? new URL(t.resource) : undefined };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const h = tokenHash(request.token);
    await updateState(this.stateDir, (s) => { s.tokens = s.tokens.filter((t) => !(t.hash === h && t.clientId === client.client_id)); });
    this.log("mcp.http.oauth.token.revoked", { clientId: client.client_id });
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.approved) if (v < now) this.approved.delete(k);
  }
}

