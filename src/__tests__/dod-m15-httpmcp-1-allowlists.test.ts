/**
 * 082-HTTPMCP — the two allowlists, in isolation (pure logic; no sockets).
 *
 * Tool allowlist: a file of tool names, `*` for all, `-name` to remove; no file means every
 * registered tool except DEFAULT_DENIED_TOOLS; a given file is authoritative.
 * Agent guard: any agent a caller names is resolved to an IDENTITY (pubkey) and refused before the
 * daemon is called unless permitted.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_DENIED_TOOLS,
  ToolsFileError,
  collectToolNames,
  resolveAllowedTools,
} from "../tool-allowlist.js";
import { guardProxy, resolvePermittedAgents } from "../agent-guard.js";
import type { ToolProxy } from "../call-proxy.js";

vi.stubEnv("CELLO_DOCUMENTS", "");
const ALL = collectToolNames();

describe("082 tool allowlist", () => {


  it("no file → every registered tool except the default-denied set", () => {
    const got = resolveAllowedTools(ALL, undefined);
    expect([...got].sort()).toEqual(ALL.filter((t) => !DEFAULT_DENIED_TOOLS.includes(t)).sort());
  });

  it("`*` alone → every registered tool, INCLUDING the default-denied ones", () => {
    expect([...resolveAllowedTools(ALL, "*\n")].sort()).toEqual([...ALL].sort());
  });

  it("`*` then `-cello_send` → everything but send", () => {
    const got = resolveAllowedTools(ALL, "# all but send\n*\n-cello_send\n");
    expect(got.has("cello_send")).toBe(false);
    expect(got.size).toBe(ALL.length - 1);
  });

  it("a plain list → exactly that list; blank lines and comments ignored", () => {
    const got = resolveAllowedTools(ALL, "\n# read only\ncello_agents\n  cello_inbox  \n");
    expect([...got].sort()).toEqual(["cello_agents", "cello_inbox"]);
  });

  it("a given file is authoritative: listing a default-denied tool allows it", () => {
    const got = resolveAllowedTools(ALL, "cello_config_set\ncello_agents\n");
    expect(got.has("cello_config_set")).toBe(true);
  });

  it("an unknown tool name fails startup and NAMES it", () => {
    let err: unknown;
    try {
      resolveAllowedTools(ALL, "cello_agents\ncello_no_such_tool\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolsFileError);
    expect((err as ToolsFileError).reason).toBe("unknown_tool");
    expect((err as ToolsFileError).message).toContain("cello_no_such_tool");
  });

  it("`-name` of an unknown tool also fails", () => {
    expect(() => resolveAllowedTools(ALL, "*\n-cello_no_such_tool\n")).toThrow(/cello_no_such_tool/);
  });

  it("a file that leaves nothing allowed fails startup", () => {
    let err: unknown;
    try {
      resolveAllowedTools(ALL, "# nothing\n");
    } catch (e) {
      err = e;
    }
    expect((err as ToolsFileError).reason).toBe("empty_set");
  });
});

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);

function roster(list: Array<{ name: string; pubkey: string }>) {
  return { agents: list.map((a) => ({ ...a, state: "online" })) };
}

function recorder(rosterFn: () => unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  return {
    calls,
    inner: {
      async call(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params });
        if (method === "cello_agents") return rosterFn();
        return { ok: true, method };
      },
    },
  };
}

describe("agent guard", () => {
  const A = "aa".repeat(32);
  const B = "bb".repeat(32);
  const inner = (agents: { name: string; agent_id: string }[]) => {
    const calls: string[] = [];
    const proxy: ToolProxy = { call: async (method, params) => {
      calls.push(`${method}:${String(params["agent"])}`);
      return method === "agents" ? { agents } : { ok: true };
    } };
    return { proxy, calls };
  };
  const both = [{ name: "alice", agent_id: A }, { name: "bob", agent_id: B }];

  it("resolves names or ids to identities; an unknown entry is named", async () => {
    const { proxy } = inner(both);
    expect([...await resolvePermittedAgents(proxy, ["alice", B])]).toEqual([A, B]);
    await expect(resolvePermittedAgents(proxy, ["carol"])).rejects.toThrow(/carol.*alice, bob/);
    await expect(resolvePermittedAgents(proxy, [])).rejects.toThrow(/empty/);
  });

  it("an unpermitted agent is refused and the daemon never gets the call", async () => {
    const { proxy, calls } = inner(both);
    await expect(guardProxy(proxy, new Set([A]), () => {}).call("send", { agent: "bob" })).rejects.toMatchObject({ code: "agent_not_permitted" });
    expect(calls.filter((c) => c.startsWith("send"))).toEqual([]);
  });

  it("a name is compared by identity: a reused name meaning another agent is refused", async () => {
    const { proxy } = inner([{ name: "alice", agent_id: B }]);
    await expect(guardProxy(proxy, new Set([A]), () => {}).call("receive", { agent: "alice" })).rejects.toMatchObject({ code: "agent_not_permitted" });
  });

  it("a name two agents share is refused unless both are permitted", async () => {
    const { proxy } = inner([{ name: "x", agent_id: A }, { name: "x", agent_id: B }]);
    await expect(guardProxy(proxy, new Set([A]), () => {}).call("receive", { agent: "x" })).rejects.toMatchObject({ code: "agent_not_permitted" });
  });

  it("a limited endpoint can't create an agent, and lists only its own", async () => {
    const { proxy } = inner(both);
    const guarded = guardProxy(proxy, new Set([A]), () => {});
    await expect(guarded.call("create_agent", { name: "new" })).rejects.toMatchObject({ code: "agent_not_permitted" });
    expect(await guarded.call("agents", {})).toEqual({ agents: [both[0]] });
  });
});
