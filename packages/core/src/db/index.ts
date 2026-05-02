/**
 * Typed catalog schema + client for spawntree.
 *
 * The schema here is the source of truth for the daemon's SQLite tables.
 * External tools import it alongside `createCatalogClient` to query the
 * catalog directly — no HTTP round-trip, no re-implementation of read
 * endpoints, full TypeScript inference on every row.
 */
export * from "./schema.ts";
export * from "./client.ts";
export * from "./http-client.ts";
export * from "./probe.ts";
export * from "./routing-client.ts";
