// The one file that names the client's package, besides package.json, so a rename touches only these two.
export { OPERATIONS, type Operation } from "@cello-protocol/cli/operations";
export { DaemonGone, DaemonRefused, IpcClient } from "@cello-protocol/cli/ipc-client";
export { TOOL_OPERATIONS, asResult, callLimitMs, inputSchema, toolParams } from "@cello-protocol/cli/mcp-tools";
export { socketPath } from "@cello-protocol/cli/paths";
