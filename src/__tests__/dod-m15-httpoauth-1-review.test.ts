/**
 * 083-HTTPOAUTH review findings — each test pins one fix.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpHttpServer } from "../http-server.js";
import { createPairingCode, consumePairingCode } from "../pairing.js";
import { updateState, loadState, withStateLock } from "../oauth-store.js";
import { CelloOAuthProvider, MAX_CLIENTS } from "../oauth-provider.js";
import { fakeDaemon, type Fake } from "./helpers/fake-daemon.js";

let dir: string;
let stateDir: string;
let fake: Fake | undefined;

beforeEach(async () => {
  vi.stubEnv("CELLO_DOCUMENTS", "");
  dir = await mkdtemp(join(tmpdir(), "httpoauth-rv-"));
  stateDir = join(dir, "mcp-http");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fake?.close().catch(() => {});
  fake = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("HIGH: revoke and the server cannot overwrite each other", () => {
  it("a state write waits while another process holds the lock", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "oauth.json.lock"), String(process.pid));
    let done = false;
    const w = updateState(stateDir, (s) => { s.tokens.push({ hash: "h", kind: "access", clientId: "c", scopes: [], expiresAt: Date.now() + 60_000 }); }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    await rm(join(stateDir, "oauth.json.lock"));
    await w;
    expect((await loadState(stateDir)).tokens.length).toBe(1);
  });

  it("a lock left by a dead process is taken over", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "oauth.json.lock"), "999999999");
    await withStateLock(stateDir, async () => {});
  });
});

describe("MEDIUM: pairing attempts cannot be multiplied by a burst", () => {
  it("ten simultaneous wrong guesses still burn the code", async () => {
    const code = await createPairingCode(stateDir);
    await Promise.all(Array.from({ length: 10 }, (_, i) => consumePairingCode(stateDir, `bad-${i}`)));
    expect((await consumePairingCode(stateDir, code)).result).not.toBe("ok");
  });
});

describe("MEDIUM: open registration is capped", () => {
  it(`refuses a registration past ${"MAX_CLIENTS"} clients that hold access`, async () => {
    const p = new CelloOAuthProvider(stateDir, () => {});
    await updateState(stateDir, (s) => {
      for (let i = 0; i < MAX_CLIENTS; i++) {
        s.clients[`c${i}`] = { client_id: `c${i}`, redirect_uris: ["https://x/cb"], client_id_issued_at: Math.floor(Date.now() / 1000) } as never;
      }
    });
    await expect(Promise.resolve(p.clientsStore.registerClient!({ client_id: "new", redirect_uris: ["https://x/cb"] } as never))).rejects.toThrow();
  });

  it("drops clients that never signed in once they are an hour old", async () => {
    const p = new CelloOAuthProvider(stateDir, () => {});
    await updateState(stateDir, (s) => {
      s.clients["old"] = { client_id: "old", redirect_uris: ["https://x/cb"], client_id_issued_at: Math.floor(Date.now() / 1000) - 7200 } as never;
    });
    await p.clientsStore.registerClient!({ client_id: "fresh", redirect_uris: ["https://x/cb"], client_id_issued_at: Math.floor(Date.now() / 1000) } as never);
    expect(Object.keys((await loadState(stateDir)).clients)).toEqual(["fresh"]);
  });
});

describe("LOW: a token for another resource is refused", () => {
  it("an access token minted for a different resource gets 401 at /mcp", async () => {
    fake = await fakeDaemon(dir);
    const h = await startMcpHttpServer({ socketPath: fake.path, host: "127.0.0.1", port: 0, token: "s".repeat(40), version: "t", oauth: { publicUrl: "http://127.0.0.1:1", stateDir }, log: () => {} });
    try {
      const { tokenHash } = await import("../oauth-store.js");
      await updateState(stateDir, (s) => { s.tokens.push({ hash: tokenHash("other"), kind: "access", clientId: "c", scopes: [], resource: "https://elsewhere.example/mcp", expiresAt: Date.now() + 60_000 }); });
      const r = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer other" }, body: "{}" });
      expect(r.status).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe("LOW: the consent page does not reveal whether a code is live", () => {
  it("no code, wrong code and expired code read the same", async () => {
    const p = new CelloOAuthProvider(stateDir, () => {});
    const pages: string[] = [];
    for (const setup of [async () => {}, async () => { await createPairingCode(stateDir); }, async () => { await createPairingCode(stateDir, { ttlMs: 1 }); await new Promise((r) => setTimeout(r, 10)); }]) {
      await setup();
      const id = await p.openPending({ client_id: "c", redirect_uris: ["https://x/cb"] } as never);
      let html = "";
      const res = { status() { return res; }, type() { return res; }, send(b: string) { html = b; return res; }, redirect() { return res; } };
      await p.approve({ body: { request: id, code: "WRONG-CODE" } } as never, res as never);
      pages.push(html.replace(/name="request" value="[^"]+"/, ""));
    }
    expect(new Set(pages).size).toBe(1);
  });
});

describe("LOW: --public-url must be https", () => {
  it("refuses a plain-http public URL that is not loopback", async () => {
    fake = await fakeDaemon(dir);
    await expect(startMcpHttpServer({ socketPath: fake.path, host: "127.0.0.1", port: 0, token: "s".repeat(40), version: "t", oauth: { publicUrl: "http://host.example", stateDir }, log: () => {} })).rejects.toThrow(/https/);
  });
});
