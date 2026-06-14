// Minimal Cloudflare Workers type stubs for CLI compatibility
// Re-exports the global Cloudflare types for project-wide consistency

export type D1Database = globalThis.D1Database;
export type D1PreparedStatement = globalThis.D1PreparedStatement;
export type D1Result<T = unknown> = globalThis.D1Result<T>;
export type D1ExecResult = { count: number; duration: number };
export type KVNamespace = globalThis.KVNamespace;
export type Ai = globalThis.Ai;
