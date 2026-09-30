/**
 * OAuth state for the endpoint, in `<stateDir>/oauth.json` (mode 0600).
 *
 * Holds registered clients and the SHA-256 HASHES of issued access and refresh tokens, never the tokens.
 * The server re-reads this file on every token check, so `cello-mcp-http revoke`, which edits it from another
 * process, takes effect on the next request.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { writePrivate } from "./private-file.js";

export interface StoredToken {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // epoch ms
}

export interface OAuthState {
  clients: Record<string, OAuthClientInformationFull>;
  tokens: StoredToken[];
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

const fileOf = (stateDir: string) => join(stateDir, "oauth.json");

export async function loadState(stateDir: string): Promise<OAuthState> {
  try {
    return JSON.parse(await readFile(fileOf(stateDir), "utf8")) as OAuthState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { clients: {}, tokens: [] };
    throw e;
  }
}

export async function saveState(stateDir: string, state: OAuthState): Promise<void> {
  const now = Date.now();
  state.tokens = state.tokens.filter((t) => t.expiresAt > now);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writePrivate(fileOf(stateDir), JSON.stringify(state, null, 2));
}

// One writer at a time within this process: two token issues interleaving their read-modify-write would
// drop one of them.
const queues = new Map<string, Promise<unknown>>();

/** Read-modify-write of the state file, serialized per state directory. */
export async function updateState<T>(stateDir: string, fn: (s: OAuthState) => T): Promise<T> {
  const prev = queues.get(stateDir) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const s = await loadState(stateDir);
    const out = fn(s);
    await saveState(stateDir, s);
    return out;
  });
  queues.set(stateDir, run);
  return run;
}

/** Removes every token (or one client's tokens). Returns how many were removed. */
export async function revokeTokens(stateDir: string, clientId?: string): Promise<number> {
  return updateState(stateDir, (s) => {
    const before = s.tokens.length;
    s.tokens = s.tokens.filter((t) => clientId !== undefined && t.clientId !== clientId);
    return before - s.tokens.length;
  });
}

export interface ClientSummary { clientId: string; name: string | undefined; registeredAt: number | undefined; liveTokens: number }

export async function listClients(stateDir: string): Promise<ClientSummary[]> {
  const s = await loadState(stateDir);
  const now = Date.now();
  return Object.values(s.clients).map((c) => ({
    clientId: c.client_id,
    name: c.client_name,
    registeredAt: c.client_id_issued_at,
    liveTokens: s.tokens.filter((t) => t.clientId === c.client_id && t.expiresAt > now).length,
  }));
}
