import { defineConfig } from "vitest/config";

// PGlite (WASM Postgres + migrations) takes several seconds to boot, more under parallel CI load.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 120_000 } });
