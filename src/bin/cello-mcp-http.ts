#!/usr/bin/env node
/**
 * cello-mcp-http — the CELLO MCP tools over Streamable HTTP, in front of the operator's own daemon.
 *
 * For MCP clients that speak only remote HTTPS. Holds no key material: it proxies to the daemon over
 * ~/.cello/daemon.sock exactly as cello-mcp does. TLS and public exposure are the operator's.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { HTTP_USAGE, McpHttpConfigError, parseHttpArgs, readTokenFile } from "../http-config.js";
import { startMcpHttpServer } from "../http-server.js";
import { createPairingCode, PAIRING_TTL_MS } from "../pairing.js";
import { listClients, revokeTokens } from "../oauth-store.js";
import { logEvent } from "@cello-protocol/connect/lib";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const celloDir = process.env["CELLO_DIR"] || join(homedir(), ".cello");
const defaultStateDir = join(celloDir, "mcp-http");

// Operator commands. They act on the state files directly, so they work whether or not the endpoint runs.
const sub = process.argv[2];
if (sub === "pair" || sub === "clients" || sub === "revoke") {
  const stateAt = process.argv.indexOf("--state-dir");
  const stateDir = stateAt !== -1 && process.argv[stateAt + 1] !== undefined ? process.argv[stateAt + 1]! : defaultStateDir;
  try {
    if (sub === "pair") {
      const code = await createPairingCode(stateDir);
      process.stdout.write(`Pairing code: ${code}\nType it into the sign-in page within ${PAIRING_TTL_MS / 60_000} minutes. It works once.\n`);
    } else if (sub === "clients") {
      const list = await listClients(stateDir);
      if (list.length === 0) process.stdout.write("No apps have signed in.\n");
      for (const c of list) process.stdout.write(`${c.clientId}  ${c.name ?? "(unnamed)"}  ${c.liveTokens > 0 ? "signed in" : "signed out"}\n`);
    } else {
      const target = process.argv.slice(3).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--state-dir");
      const n = await revokeTokens(stateDir, target);
      process.stdout.write(`Revoked ${n} token(s)${target ? ` for ${target}` : ""}. ${target ? "That app" : "Every app"} must sign in again.\n`);
    }
    process.exit(0);
  } catch (err: unknown) {
    process.stderr.write(`cello-mcp-http ${sub}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

try {
  const args = parseHttpArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HTTP_USAGE);
    process.exit(0);
  }
  const envToken = process.env["CELLO_MCP_HTTP_TOKEN"]?.trim() ?? "";
  const token = args.tokenFile !== undefined ? readTokenFile(args.tokenFile) : envToken;

  const handle = await startMcpHttpServer({
    socketPath: join(celloDir, "daemon.sock"),
    host: args.host,
    port: args.port,
    token,
    version: pkg.version,
    agents: args.agents,
    toolsFileText: args.toolsFile !== undefined ? readFileSync(args.toolsFile, "utf8") : undefined,
    tls: args.tlsCert !== undefined && args.tlsKey !== undefined
      ? { cert: readFileSync(args.tlsCert, "utf8"), key: readFileSync(args.tlsKey, "utf8") }
      : undefined,
    oauth: args.publicUrl !== undefined ? { publicUrl: args.publicUrl, stateDir: args.stateDir ?? defaultStateDir } : undefined,
    maxSessions: args.maxSessions,
    idleTimeoutMs: args.idleTimeoutS * 1000,
  });

  const stop = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (err: unknown) {
  const reason = err instanceof McpHttpConfigError ? err.reason : "startup_failed";
  const message = err instanceof Error ? err.message : String(err);
  logEvent("mcp.http.config.invalid", { reason, message });
  process.stderr.write(`cello-mcp-http: ${message}\n`);
  process.exit(1);
}
