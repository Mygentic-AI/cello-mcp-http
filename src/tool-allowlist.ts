/**
 * Which of the registered MCP tools an HTTP endpoint exposes.
 *
 * File format, one entry per line: `#` comments and blank lines ignored; `*` adds every registered
 * tool; a bare name adds that tool; `-name` removes it. Processed in order. A given file is
 * AUTHORITATIVE — DEFAULT_DENIED_TOOLS applies only when there is no file.
 */

import { registerCelloTools, type ToolSink } from "@cello-protocol/connect/lib";

/**
 * Tools hidden when there is no tools file. Empty since M15D: a hosted user has no terminal, so a
 * tool hidden "for the operator to run at a terminal" was a tool nobody could run. The mechanism
 * stays for an operator who wants to narrow the surface with --tools-file.
 */
export const DEFAULT_DENIED_TOOLS: readonly string[] = [];

export type ToolsFileReason = "unknown_tool" | "empty_set";

export class ToolsFileError extends Error {
  constructor(readonly reason: ToolsFileReason, message: string) {
    super(message);
    this.name = "ToolsFileError";
  }
}

/** The names `registerCelloTools` declares, learned by running it against a recording sink. */
export function collectToolNames(): string[] {
  const names: string[] = [];
  const sink = { tool: (name: string) => { names.push(name); } } as unknown as ToolSink;
  registerCelloTools(sink, { call: async () => undefined });
  return names;
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

/**
 * The shared tool list (`registerCelloTools`, written against the SDK v1 `tool()` call) declared on
 * an SDK v2 server, allowed tools only — the rest are never declared on it. Adapted here, at this
 * endpoint's boundary, so the plugin's registry is not forked.
 */
export function v2Sink(target: unknown, allowed: ReadonlySet<string>): ToolSink {
  const server = target as V2Server;
  const tool = (name: string, description: string, shape: Record<string, unknown>, cb: (args: Record<string, unknown>) => unknown) => {
    if (!allowed.has(name)) return undefined;
    return server.registerTool(name, { description, inputSchema: shape }, (args) => cb(args ?? {}));
  };
  return { tool } as unknown as ToolSink;
}
