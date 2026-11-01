/**
 * One daemon socket per tool call — M15D 002-ENDPOINT.
 *
 * ChatGPT and the Claude.ai connector open a new MCP session for every tool call and never close it.
 * When each session held its own daemon socket, sixteen calls filled the daemon and the hosted
 * container restarted under the conversation. So no socket here outlives its call: it opens as an
 * `endpoint` socket, carries the caller from the verified token on every request (contract C2), and
 * closes when the call returns.
 *
 * The HTTP request that carried the call is the request scope. If its client hangs up first, the
 * scope aborts and the socket closes — the daemon then stops a waiting receive and marks nothing
 * read (C4). A receive's delivery token is held in the scope and committed only once the HTTP
 * response has been written (C3); the token itself never reaches the model.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { IpcProxy, type LogFn, type ToolProxy } from "@cello-protocol/connect/lib";

export interface Caller {
  /** Opaque to the daemon: `oauth:<clientId>` or `static`. Never taken from anything the client sends. */
  id: string;
  /** Display only — who the daemon names when it refuses someone else. */
  label: string;
}

export interface RequestScope {
  signal: AbortSignal;
  /** Delivery tokens to commit once the response is written. */
  commits: string[];
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

export async function openEndpointSocket(socketPath: string, caller: Caller): Promise<IpcProxy> {
  const proxy = new IpcProxy(socketPath, { clientType: "endpoint", caller });
  await proxy.connect();
  await proxy.call("ipc.connect", { clientType: "endpoint" });
  return proxy;
}

export function callProxy(opts: { socketPath: string; caller: Caller; log: LogFn }): ToolProxy {
  const { socketPath, caller, log } = opts;
  return {
    async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
      const scope = requestScope.getStore();
      if (scope?.signal.aborted) return { ok: false, reason: "caller_gone", guidance: "The request was closed before the call ran." };
      const proxy = await openEndpointSocket(socketPath, caller);
      const hangUp = () => proxy.close();
      scope?.signal.addEventListener("abort", hangUp, { once: true });
      try {
        const result = (await proxy.call(method, params)) as Record<string, unknown> | null;
        if (method === "cello_receive" && result !== null && typeof result === "object" && typeof result["commit"] === "string") {
          const { commit, ...rest } = result;
          if (scope && !scope.signal.aborted) scope.commits.push(commit as string);
          else log("mcp.http.receive.uncommitted", { reason: scope ? "caller_gone" : "no_request_scope" });
          return rest;
        }
        return result;
      } finally {
        scope?.signal.removeEventListener("abort", hangUp);
        proxy.close();
      }
    },
  };
}

/** Mark delivered receives read. Failures are logged: the messages stay unread and come back. */
export async function commitDeliveries(socketPath: string, caller: Caller, tokens: string[], log: LogFn): Promise<void> {
  if (tokens.length === 0) return;
  let proxy: IpcProxy | undefined;
  try {
    proxy = await openEndpointSocket(socketPath, caller);
    for (const token of tokens) {
      const r = (await proxy.call("session.receive.commit", { token })) as { ok?: boolean; reason?: string } | null;
      if (r?.ok !== true) log("mcp.http.receive.commit_failed", { reason: r?.reason ?? "no_answer", impact: "these messages stay unread and the next cello_receive returns them" });
    }
  } catch (e) {
    log("mcp.http.receive.commit_failed", { reason: e instanceof Error ? e.message : String(e), impact: "these messages stay unread and the next cello_receive returns them" });
  } finally {
    proxy?.close();
  }
}
