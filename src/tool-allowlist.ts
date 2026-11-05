/**
 * Which of the registered MCP tools an HTTP endpoint exposes.
 *
 * File format, one entry per line: `#` comments and blank lines ignored; `*` adds every registered
 * tool; a bare name adds that tool; `-name` removes it. Processed in order. A given file is
 * AUTHORITATIVE — DEFAULT_DENIED_TOOLS applies only when there is no file.
 */

import type { Caller, ToolProxy } from "./call-proxy.js";
import { TOOL_OPERATIONS, asResult, callLimitMs, inputSchema, toolParams } from "./v2.js";

/**
 * Tools that read or write a path on this machine. The caller is somewhere else, so it could never
 * see the file, and it must not be able to touch paths here. cello_export_seal returns a seal directly.
 */
const FILE_METHODS: ReadonlySet<string> = new Set(["export_transcript", "verify_seal", "verify_transcript"]);
const WEB_OPERATIONS = TOOL_OPERATIONS.filter((op) => !FILE_METHODS.has(op.method));

/** Web clients and the proxies in front of them give up on a long call, so a wait is short unless asked. */
const WEB_WAIT_SECONDS = 50;

export const DEFAULT_DENIED_TOOLS: readonly string[] = [];

export type ToolsFileReason = "unknown_tool" | "empty_set";

export class ToolsFileError extends Error {
  constructor(readonly reason: ToolsFileReason, message: string) {
    super(message);
    this.name = "ToolsFileError";
  }
}

export function collectToolNames(): string[] {
  return WEB_OPERATIONS.map((op) => op.tool);
}

export function resolveAllowedTools(all: readonly string[], fileText: string | undefined): Set<string> {
  if (fileText === undefined) return new Set(all.filter((t) => !DEFAULT_DENIED_TOOLS.includes(t)));

  const known = new Set(all);
  const allowed = new Set<string>();
  for (const raw of fileText.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "*") {
      for (const t of all) allowed.add(t);
      continue;
    }
    const remove = line.startsWith("-");
    const name = remove ? line.slice(1).trim() : line;
    if (!known.has(name)) {
      throw new ToolsFileError(
        "unknown_tool",
        `tools file names "${name}", which is not a registered CELLO tool. Registered tools: ${all.join(", ")}`,
      );
    }
    if (remove) allowed.delete(name);
    else allowed.add(name);
  }
  if (allowed.size === 0) {
    throw new ToolsFileError("empty_set", "tools file leaves no tool allowed; an endpoint that exposes nothing is a misconfiguration");
  }
  return allowed;
}

type V2Server = { registerTool(name: string, config: { description?: string; inputSchema?: unknown }, cb: (args: Record<string, unknown>) => unknown): unknown };

/** Declares the allowed tools on one server. The rest don't exist on it. */
export function registerTools(server: unknown, allowed: ReadonlySet<string>, proxy: ToolProxy, caller: Caller): void {
  for (const op of WEB_OPERATIONS) {
    if (!allowed.has(op.tool)) continue;
    (server as V2Server).registerTool(op.tool, { description: op.description, inputSchema: inputSchema(op) }, (given) => {
      const args = op.method === "wait" ? { timeout_seconds: WEB_WAIT_SECONDS, ...given } : (given ?? {});
      return asResult(() => proxy.call(op.method, toolParams(args, caller.id), callLimitMs(op, args)));
    });
  }
}
