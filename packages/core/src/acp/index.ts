export type {
  ACPAdapter,
  // ContentBlock, SessionStatus, SessionToolCallData, SessionTurnData are
  // exported from api/schemas.ts with runtime-validatable Schema definitions.
  // Export only the types that don't have Schema counterparts here.
  DiscoveredSession,
  SessionEvent,
  // SessionDetail is the plain interface from the adapter; the Schema version
  // (with `session` metadata) is in api/schemas.ts. Export as ACPSessionDetail
  // to avoid ambiguity when both are needed.
  SessionDetail as ACPSessionDetail,
} from "./adapter.ts";
export { ACPConnection } from "./client.ts";
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
