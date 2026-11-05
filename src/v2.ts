// The one file that names the client's package, besides package.json, so a rename touches only these two.
export { OPERATIONS, type Operation } from "cello-v2/operations";
export { DaemonGone, DaemonRefused, IpcClient } from "cello-v2/ipc-client";
export { TOOL_OPERATIONS, asResult, callLimitMs, inputSchema, toolParams } from "cello-v2/mcp-tools";
export { socketPath } from "cello-v2/paths";
