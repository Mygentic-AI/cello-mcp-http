/**
 * A client that installs only this endpoint must still learn how to use CELLO. Two carriers:
 *   - the server's own `instructions`, sent on every connection to any MCP client;
 *   - a skill (`skills/cello/SKILL.md`), shipped standalone and inside the plugin.
 * These tests pin both, and pin that the two copies of the skill cannot drift apart.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer, type McpHttpHandle } from "../http-server.js";
import { fakeDaemon, type Fake } from "./helpers/fake-daemon.js";
import { SERVER_INSTRUCTIONS } from "../instructions.js";

const TOKEN = "t".repeat(40);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STANDALONE = join(root, "skills", "cello", "SKILL.md");
const IN_PLUGIN = join(root, "plugins", "cello-remote", "skills", "cello", "SKILL.md");

let dir: string;
let fake: Fake;
let handle: McpHttpHandle | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  await handle?.close().catch(() => {});
  handle = undefined;
  await fake?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("server instructions", () => {
  it("a remote client is handed the usage guide when it connects", async () => {
    dir = await mkdtemp(join(tmpdir(), "httpmcp-instr-"));
    fake = await fakeDaemon(dir);
    handle = await startMcpHttpServer({ socketPath: fake.path, host: "127.0.0.1", port: 0, token: TOKEN, version: "0.0.0-test", log: () => {} });
    client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("covers the rules a first-time caller gets wrong, and stays short enough to read every time", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/signal/);
    expect(SERVER_INSTRUCTIONS).toMatch(/cello_session_id/);
    expect(SERVER_INSTRUCTIONS).toMatch(/agent/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/policy/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/cello_close_session/);
    expect(SERVER_INSTRUCTIONS).toMatch(/cello_sealed_receipt/);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(4000);
  });

  it("names no single vendor's client", () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/claude|anthropic|cowork|chatgpt|openai/i);
  });
});

describe("the skill", () => {
  it("exists standalone and inside the plugin", () => {
    expect(existsSync(STANDALONE)).toBe(true);
    expect(existsSync(IN_PLUGIN)).toBe(true);
  });

  it("the two copies are byte-identical, so they cannot drift", () => {
    expect(readFileSync(IN_PLUGIN, "utf8")).toBe(readFileSync(STANDALONE, "utf8"));
  });

  it("carries the frontmatter a skill loader needs", () => {
    const text = readFileSync(STANDALONE, "utf8");
    expect(text).toMatch(/^---\nname: cello\ndescription: .{40,}\n---\n/);
  });

  it("teaches the remote-specific rules", () => {
    const text = readFileSync(STANDALONE, "utf8");
    expect(text).toMatch(/pass the agent|`agent`/i);
    expect(text).toMatch(/no approve tool|cannot approve|there is no approve/i);
    expect(text).toMatch(/cello_session_id/);
    expect(text).toMatch(/seal_in_progress/);
  });

  it("does not tell a remote caller to fix the daemon from where it cannot", () => {
    const text = readFileSync(STANDALONE, "utf8");
    expect(text).not.toMatch(/\/plugin (update|install)/);
    expect(text).not.toMatch(/--channels plugin:/);
  });
});
