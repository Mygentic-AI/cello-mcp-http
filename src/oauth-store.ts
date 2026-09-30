/**
 * OAuth state for the endpoint, in `<stateDir>/oauth.json` (mode 0600).
 *
 * Holds registered clients and the SHA-256 HASHES of issued access and refresh tokens, never the tokens.
 * The server re-reads this file on every token check, so `cello-mcp-http revoke`, which edits it from another
 * process, takes effect on the next request.
 */
import { mkdir, readFile, open, rm } from "node:fs/promises";
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

// Two layers. In this process, a queue: two token issues interleaving their read-modify-write would drop
// one. Across processes, a lock file: `cello-mcp-http revoke` runs as its own process, and without the
// lock a refresh landing mid-revoke would write the revoked tokens back.
const queues = new Map<string, Promise<unknown>>();
const LOCK_WAIT_MS = 10_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs `fn` holding `<stateDir>/oauth.json.lock`. A lock left by a process that no longer exists is taken over. */
export async function withStateLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, "oauth.json.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const h = await open(lock, "wx", 0o600);
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number((await readFile(lock, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && !alive(holder)) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock} (held by pid ${holder}); if no cello-mcp-http is running, delete it`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** Read-modify-write of the state file: queued in this process, locked across processes. */
export async function updateState<T>(stateDir: string, fn: (s: OAuthState) => T): Promise<T> {
  const prev = queues.get(stateDir) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => withStateLock(stateDir, async () => {
    const s = await loadState(stateDir);
    const out = fn(s);
    await saveState(stateDir, s);
    return out;
  }));
  queues.set(stateDir, run);
  return run;
}

/** Serializes any other read-modify-write in the state directory (the pairing file) the same way. */
export async function serialized<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(stateDir) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => withStateLock(stateDir, fn));
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
