/** A fake CELLO daemon on a real Unix socket: newline-delimited JSON, the IpcProxy wire. */
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export const A = "aa".repeat(32);
export const B = "bb".repeat(32);

export interface Rec { method: string; params: Record<string, unknown> | undefined; conn: number; caller?: unknown }
export interface Fake {
  path: string;
  calls: Rec[];
  closedConns: Set<number>;
  connCount: () => number;
  roster: Array<{ name: string; pubkey: string; state: string }>;
  /** M15D: most daemon sockets open at the same moment, and how many are open now. */
  maxOpen: () => number;
  openNow: () => number;
  /** M15D: answer a method yourself (may delay); return undefined for the default answer. */
  respond?: (method: string, params: Record<string, unknown> | undefined, conn: number) => Promise<unknown> | unknown;
  /** M15D: push a daemon notification frame to one connection. */
  push(conn: number, frame: Record<string, unknown>): void;
  close(): Promise<void>;
}

export async function fakeDaemon(dir: string): Promise<Fake> {
  const path = join(dir, "daemon.sock");
  const calls: Rec[] = [];
  const closedConns = new Set<number>();
  const sockets: Socket[] = [];
  let open = 0;
  let maxOpen = 0;
  const fake: Fake = {
    path, calls, closedConns,
    connCount: () => sockets.length,
    maxOpen: () => maxOpen,
    openNow: () => open,
    push: (conn, frame) => { sockets[conn - 1]?.write(JSON.stringify(frame) + "\n"); },
    roster: [
      { name: "alice", pubkey: A, state: "online" },
      { name: "bob", pubkey: B, state: "online" },
    ],
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
  const server: Server = createServer((socket) => {
    const conn = sockets.push(socket);
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    let buf = "";
    socket.on("data", (c: Buffer) => {
      buf += c.toString("utf-8");
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown>; caller?: unknown };
        calls.push({ method: req.method, params: req.params, conn, ...(req.caller !== undefined ? { caller: req.caller } : {}) });
        const fallback = () => (req.method === "cello_list_agents" ? { agents: fake.roster } : { ok: true, method: req.method });
        void Promise.resolve(fake.respond?.(req.method, req.params, conn)).then((custom) => {
          if (!socket.destroyed) socket.write(JSON.stringify({ id: req.id, result: custom ?? fallback() }) + "\n");
        });
      }
    });
    socket.on("close", () => { closedConns.add(conn); open -= 1; });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  return fake;
}
