export type {
  ACPAdapter,
  // ContentBlock, SessionStatus, SessionToolCallData, SessionTurnData,
  // ToolCallApprovalOption are exported from api/schemas.ts with
  // runtime-validatable Schema definitions. Export only the types that
  // don't have Schema counterparts here.
  DiscoveredSession,
  SessionEvent,
  // SessionDetail is the plain interface from the adapter; the Schema version
  // (with `session` metadata) is in api/schemas.ts. Export as ACPSessionDetail
  // to avoid ambiguity when both are needed.
  SessionDetail as ACPSessionDetail,
} from "./adapter.ts";
// Re-exported from the ACP package so consumers (e.g. the daemon) can wire
// up a custom permissionHandler without adding a direct dependency on
// `@zed-industries/agent-client-protocol`.
export type {
  RequestPermissionRequest as ACPRequestPermissionRequest,
  RequestPermissionResponse as ACPRequestPermissionResponse,
} from "@zed-industries/agent-client-protocol";
export {
  ProviderCapabilityError,
  SessionBusyError,
  SessionDeleteUnsupportedError,
  UnknownProviderError,
} from "./adapter.ts";
export { ACPConnection, buildDefaultClient } from "./client.ts";
export type {
  ACPConnectionOptions,
  DefaultClientOptions,
  SessionUpdateDispatch,
} from "./client.ts";
export { JsonRpcTransport } from "./json-rpc.ts";
export type { JsonRpcTransportOptions } from "./json-rpc.ts";
export { ClaudeCodeAdapter } from "./adapters/claude-code.ts";
export type { ClaudeCodeAdapterOptions } from "./adapters/claude-code.ts";
export { CodexACPAdapter } from "./adapters/codex.ts";
