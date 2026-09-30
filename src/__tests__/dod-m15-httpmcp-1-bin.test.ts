/**
 * 082-HTTPMCP — the SHIPPED binary (`dist/bin/cello-mcp-http.js`) as its own OS process: flag parsing,
 * token file, tools file, exit codes, and a real HTTP client against it. Needs `pnpm run typecheck`
 * (which emits dist/) first, like every test that launches a binary.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fakeDaemon, type Fake } from "./helpers/fake-daemon.js";

const BIN = resolve(import.meta.dirname, "../../dist/bin/cello-mcp-http.js");
const TOKEN = "s".repeat(40);

let dir = "";
let fake: Fake | undefined;
let proc: ChildProcess | undefined;

afterEach(async () => {
  proc?.kill("SIGKILL");
  proc = undefined;
  await fake?.close().catch(() => {});
  fake = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

function run(args: string[], env: Record<string, string> = {}): { child: ChildProcess; out: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, CELLO_DIR: dir, CELLO_DOCUMENTS: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  proc = child;
  let text = "";
  child.stdout!.on("data", (c: Buffer) => (text += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (text += c.toString()));
  return { child, out: () => text, exited: new Promise((r) => child.on("exit", (code) => r(code))) };
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

describe("082 cello-mcp-http binary", () => {
  it("is built", () => {
    expect(existsSync(BIN), "dist/ is not built — run `pnpm run typecheck`").toBe(true);
  });

  it("no token → exits 1 naming the fix, and never listens", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-bin-"));
    const r = run(["--port", String(await freePort())], { CELLO_MCP_HTTP_TOKEN: "" });
    expect(await r.exited).toBe(1);
    expect(r.out()).toMatch(/no bearer token configured/);
    expect(r.out()).not.toContain("mcp.http.listening");
  });

  it("--agents naming an agent the daemon lacks → exits 1 naming it and the agents that exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-bin-"));
    fake = await fakeDaemon(dir);
    const r = run(["--port", String(await freePort()), "--agents", "alice,zed"], { CELLO_MCP_HTTP_TOKEN: TOKEN });
    expect(await r.exited).toBe(1);
    expect(r.out()).toMatch(/zed[\s\S]*alice[\s\S]*bob/);
  });

  it("a group-readable --token-file → exits 1", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-bin-"));
    const tf = join(dir, "token");
    await writeFile(tf, TOKEN);
    await chmod(tf, 0o644);
    const r = run(["--port", String(await freePort()), "--token-file", tf]);
    expect(await r.exited).toBe(1);
    expect(r.out()).toMatch(/chmod 600/);
  });

  it("serves exactly the tools file over HTTP for a client holding the token file's token, limited to --agents", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-bin-"));
    fake = await fakeDaemon(dir);
    const tf = join(dir, "token");
    const tools = join(dir, "tools.txt");
    await writeFile(tf, `${TOKEN}\n`);
    await chmod(tf, 0o600);
    await writeFile(tools, "# read only\ncello_agents\ncello_use_agent\n");
    const port = await freePort();
    const r = run(["--port", String(port), "--token-file", tf, "--tools-file", tools, "--agents", "alice"]);
    await until(() => r.out().includes("mcp.http.listening"));
    expect(r.out(), "the binary never reported listening").toContain("mcp.http.listening");

    const c = new Client({ name: "bin-test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["cello_agents", "cello_use_agent"]);
    const bob = JSON.parse(((await c.callTool({ name: "cello_use_agent", arguments: { name: "bob" } })) as { content: Array<{ text: string }> }).content[0]!.text);
    expect(bob.reason).toBe("agent_not_permitted");
    const alice = JSON.parse(((await c.callTool({ name: "cello_use_agent", arguments: { name: "alice" } })) as { content: Array<{ text: string }> }).content[0]!.text);
    expect(alice.ok).toBe(true);
    await c.close();
  });
});

describe("083 operator commands", () => {
  it("pair prints a code that the endpoint's pairing check accepts once", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-bin-"));
    const r = run(["pair"]);
    expect(await r.exited).toBe(0);
    const code = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.out())?.[1];
    expect(code).toBeDefined();
    const { consumePairingCode } = await import("../pairing.js");
    expect((await consumePairingCode(join(dir, "mcp-http"), code!)).result).toBe("ok");
    expect((await consumePairingCode(join(dir, "mcp-http"), code!)).result).toBe("no_code");
  });

  it("clients and revoke run against the state directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-bin-"));
    const { updateState, loadState } = await import("../oauth-store.js");
    const sd = join(dir, "mcp-http");
    await updateState(sd, (s) => {
      s.clients["c1"] = { client_id: "c1", client_name: "Claude", redirect_uris: ["https://x/cb"] } as never;
      s.tokens.push({ hash: "h", kind: "access", clientId: "c1", scopes: [], expiresAt: Date.now() + 60_000 });
    });
    const list = run(["clients"]);
    expect(await list.exited).toBe(0);
    expect(list.out()).toContain("c1  Claude  signed in");
    const rv = run(["revoke"]);
    expect(await rv.exited).toBe(0);
    expect(rv.out()).toContain("Revoked 1 token(s)");
    expect((await loadState(sd)).tokens).toEqual([]);
  });
});
