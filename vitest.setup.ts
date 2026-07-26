/**
 * Unit tests must not depend on a real Supabase project. Provide syntactically
 * valid placeholders so `src/env.ts` parses; suites that need real credentials
 * (the RLS suite) load `.env.local` themselves and run under `pnpm test:rls`.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-000000';
process.env.NEXT_PUBLIC_ROOT_DOMAIN ??= 'localhost:3000';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-000000';
