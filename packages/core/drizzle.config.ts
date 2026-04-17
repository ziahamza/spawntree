import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config for the spawntree catalog.
 *
 * Use `pnpm --filter spawntree-core drizzle-kit generate` after editing
 * `src/db/schema.ts` to produce a new migration under `src/db/migrations/`.
 * The daemon applies migrations at `StorageManager.start()` via Drizzle's
 * runtime `migrate()` helper.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  // For schema-checking / generation only — the real connection is opened
  // at runtime by the StorageManager. `drizzle-kit push` against this URL
  // is explicitly not supported; always go through generated migrations.
  dbCredentials: {
    url: "file:./.drizzle-dev.db",
  },
});
