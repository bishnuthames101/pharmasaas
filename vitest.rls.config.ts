import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';

/**
 * RLS suite. Unlike the unit suite these tests talk to a real Postgres and
 * assert that tenant A can never reach tenant B's rows, so they need genuine
 * credentials from `.env.local` and run serially against shared state.
 */
loadEnv({ path: '.env.local', quiet: true });

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['supabase/tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
