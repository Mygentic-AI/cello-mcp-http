/**
 * One daemon socket per tool call. ChatGPT and the Claude.ai connector open a new MCP session for
 * every call and never close it, so no socket here outlives its call. The caller is in every request,
 * from the verified token, and the hold belongs to that caller, so closing a socket loses nothing.
 *
 * The HTTP request that carried the call is its scope. If the client hangs up first, the socket closes
 * and the daemon ends any wait. A read is counted only once the HTTP reply has been written, so a reply
 * lost on the way out leaves the messages unread. The commit token never reaches the model.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LogFn } from "./log.js";
import { DaemonRefused, IpcClient } from "./v2.js";

export interface Caller {
  /** Opaque to the daemon: `oauth:<clientId>` or `static`. Never taken from anything the client sends. */
  id: string;
  /** Display only. */
  label: string;
}

export interface PendingCommit { agent: string; token: string }

export interface RequestScope {
  signal: AbortSignal;
  commits: PendingCommit[];
}

export interface ToolProxy {
  call(method: string, params: Record<string, unknown>, limitMs?: number): Promise<unknown>;
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

const COUNTED_READS: ReadonlySet<string> = new Set(["receive", "channel_read"]);

export class DaemonRoute {
  readonly #socketPath: string;
  readonly #log: LogFn;
  // A later call waits for commits already under way, so "more": true can't return the same page again.
  #commits: Promise<void> = Promise.resolve();

  constructor(socketPath: string, log: LogFn) {
    this.#socketPath = socketPath;
    this.#log = log;
  }

  proxy(): ToolProxy {
    return {
      call: async (method, params, limitMs) => {
        const scope = requestScope.getStore();
        await this.#commits;
        if (scope?.signal.aborted) throw new DaemonRefused("caller_gone", "The request was closed before the call ran.");
        const client = await IpcClient.connect(this.#socketPath);
        const hangUp = (): void => client.close();
        scope?.signal.addEventListener("abort", hangUp, { once: true });
        try {
          const deferred = COUNTED_READS.has(method) && scope !== undefined;
          const result = await client.call(method, deferred ? { ...params, defer_commit: true } : params, limitMs);
          if (!deferred) return result;
          const { commit_token: token, ...shown } = result as { commit_token?: string };
          if (typeof token !== "string") throw new Error(`the daemon's ${method} answer has no commit_token`);
          if (scope.signal.aborted) this.#log("mcp.http.read.uncommitted", { reason: "caller_gone" });
          else scope.commits.push({ agent: params["agent"] as string, token });
          return shown;
        } finally {
          scope?.signal.removeEventListener("abort", hangUp);
          client.close();
        }
      },
    };
  }

  /** Count delivered reads. A failure is logged: the messages stay unread and come back. */
  commit(caller: Caller, commits: readonly PendingCommit[]): void {
    if (commits.length === 0) return;
    this.#commits = this.#commits.then(async () => {
      let client: IpcClient | undefined;
      try {
        client = await IpcClient.connect(this.#socketPath);
        for (const { agent, token } of commits) await client.call("commit_read", { agent, token, caller: caller.id });
      } catch (err: unknown) {
        this.#log("mcp.http.read.commit_failed", { reason: err instanceof Error ? err.message : String(err), impact: "these messages stay unread and the next read returns them" });
      } finally {
        client?.close();
      }
    });
  }
}
