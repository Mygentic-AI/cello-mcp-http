/**
 * Which agents an HTTP endpoint may serve. The unit is the agent_id, never its name: a name in a call
 * is resolved against a fresh roster before it is compared, so a renamed agent, or a name reused after
 * retirement, can't pass as a permitted one. Every call names its agent in `agent`.
 */
import type { ToolProxy } from "./call-proxy.js";
import { logEvent, type LogFn } from "./log.js";
import { DaemonRefused } from "./v2.js";

export type AgentGuardReason = "agents_empty" | "agent_unknown";

export class AgentGuardError extends Error {
  constructor(readonly reason: AgentGuardReason, message: string) {
    super(message);
    this.name = "AgentGuardError";
  }
}

interface RosterEntry { name: string; agent_id: string }

async function roster(proxy: ToolProxy): Promise<RosterEntry[]> {
  return ((await proxy.call("agents", {})) as { agents: RosterEntry[] }).agents;
}

/** Startup: turn the operator's names-or-ids into a set of identities, or fail naming what is wrong. */
export async function resolvePermittedAgents(proxy: ToolProxy, entries: readonly string[]): Promise<Set<string>> {
  if (entries.length === 0) {
    throw new AgentGuardError("agents_empty", "an agent list was given but it is empty; name at least one agent, or omit it to serve all");
  }
  const existing = await roster(proxy);
  const permitted = new Set<string>();
  const unknown: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    const hit = existing.find((a) => a.name === entry || a.agent_id === entry.toLowerCase());
    if (hit) permitted.add(hit.agent_id);
    else unknown.push(entry);
  }
  if (unknown.length > 0) {
    throw new AgentGuardError("agent_unknown", `unknown agent(s): ${unknown.join(", ")}. Agents this daemon has: ${existing.map((a) => a.name).join(", ") || "(none)"}`);
  }
  return permitted;
}

export function guardProxy(inner: ToolProxy, permitted: ReadonlySet<string> | "all", log: LogFn = logEvent): ToolProxy {
  if (permitted === "all") return inner;

  const refuse = async (asked: string, method: string): Promise<never> => {
    const names = (await roster(inner)).filter((a) => permitted.has(a.agent_id)).map((a) => a.name);
    log("mcp.http.agent.refused", { method, agent: asked });
    throw new DaemonRefused("agent_not_permitted", `This endpoint serves only: ${names.join(", ")}. "${asked}" is not one of them. Its operator chose that list at startup, and it can't be widened from here.`);
  };

  return {
    async call(method, params, limitMs) {
      // A new agent could never be on a list fixed at startup.
      if (method === "create_agent") return refuse(String(params["name"]), method);
      const asked = params["agent"];
      if (asked !== undefined) {
        if (typeof asked !== "string") return refuse(String(asked), method);
        const matches = (await roster(inner)).filter((a) => a.name === asked || a.agent_id === asked.toLowerCase());
        if (matches.length === 0 || matches.some((a) => !permitted.has(a.agent_id))) return refuse(asked, method);
      }
      const result = await inner.call(method, params, limitMs);
      // agents and status both list every agent on the daemon, with its sessions.
      const listed = (result as { agents?: { agent_id?: string }[] } | null)?.agents;
      if (!Array.isArray(listed)) return result;
      return { ...(result as object), agents: listed.filter((a) => typeof a.agent_id === "string" && permitted.has(a.agent_id)) };
    },
  };
}
