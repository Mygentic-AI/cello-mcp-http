/**
 * The CELLO client, loaded from where it is installed on this machine (`client-locator.ts`). This is
 * the one file that names the client's package, besides package.json, and there it is a
 * devDependency: these imports are types only, so nothing here makes npm install a second copy.
 *
 * Importing this file is what loads the client, so anything that must run without one (`--help`,
 * `pair`, `clients`, `revoke`) must not import it, directly or through another file.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as OperationsModule from "@cello-protocol/cli/operations";
import type * as IpcModule from "@cello-protocol/cli/ipc-client";
import type * as ToolsModule from "@cello-protocol/cli/mcp-tools";
import type * as PathsModule from "@cello-protocol/cli/paths";
import { ClientLocateError, locateClient, type ClientSubpath } from "./client-locator.js";

const found = locateClient({ env: process.env, ownDir: fileURLToPath(new URL("..", import.meta.url)) });

async function load<T extends object>(sub: ClientSubpath, names: readonly (keyof T & string)[]): Promise<T> {
  const loaded = (await import(pathToFileURL(found.files[sub]).href)) as T;
  for (const name of names) {
    if (loaded[name] === undefined) {
      throw new ClientLocateError(
        "client_unusable",
        `The CELLO client at ${found.dir} (version ${found.version}) has no "${name}" in its "${sub.slice(2)}" part, which this endpoint needs. Upgrade it: \`npm i -g @cello-protocol/cli\`.`,
      );
    }
  }
  return loaded;
}

const operations = await load<typeof OperationsModule>("./operations", ["OPERATIONS"]);
const ipc = await load<typeof IpcModule>("./ipc-client", ["DaemonGone", "DaemonRefused", "IpcClient"]);
const tools = await load<typeof ToolsModule>("./mcp-tools", ["TOOL_OPERATIONS", "asResult", "callLimitMs", "inputSchema", "toolParams"]);
const paths = await load<typeof PathsModule>("./paths", ["socketPath"]);

/** Which client this process loaded, for the startup log. */
export const CLIENT = { dir: found.dir, version: found.version, source: found.source } as const;

export type Operation = OperationsModule.Operation;
export const { OPERATIONS } = operations;

export type DaemonGone = IpcModule.DaemonGone;
export type DaemonRefused = IpcModule.DaemonRefused;
export type IpcClient = IpcModule.IpcClient;
export const { DaemonGone, DaemonRefused, IpcClient } = ipc;

export const { TOOL_OPERATIONS, asResult, callLimitMs, inputSchema, toolParams } = tools;
export const { socketPath } = paths;
