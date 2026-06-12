// env.d.ts
// Augments the Cloudflare worker env type so TypeScript knows about
// our D1, KV, AI, and Service bindings on the `env` object returned
// by @opennextjs/cloudflare's getCloudflareContext().

interface CloudflareEnv {
  DB:           D1Database;
  CACHE:        KVNamespace;
  AI:           Ai;
  ASSETS:       Fetcher;
  SCAN_WORKER?: { fetch: (req: Request) => Promise<Response> };
  SUMMARY_MODEL?: string;
  SCAN_WORKER_URL?: string;
}
