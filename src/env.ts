import { z } from 'zod';

/**
 * Environment contract. Parsed once at module load so a misconfigured
 * deployment fails loudly at boot rather than at the first query.
 *
 * Server-only secrets live in `serverEnv` and are read lazily — importing this
 * module from a Client Component must never require them to exist.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_ROOT_DOMAIN: z.string().min(1).default('localhost:3000'),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

/**
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only for literal
 * property accesses, so these must be written out longhand.
 */
const parsedClient = clientSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_ROOT_DOMAIN: process.env.NEXT_PUBLIC_ROOT_DOMAIN,
});

if (!parsedClient.success) {
  throw new Error(
    `Invalid public environment variables:\n${z.prettifyError(parsedClient.error)}\n` +
      'Copy .env.example to .env.local and fill in your Supabase project values.',
  );
}

export const env = parsedClient.data;

let cachedServerEnv: z.infer<typeof serverSchema> | null = null;

/**
 * Service-role secret. Throws if called from a client bundle or when unset.
 * Only `src/lib/supabase/admin.ts` should need this.
 */
export function serverEnv(): z.infer<typeof serverSchema> {
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid server environment variables:\n${z.prettifyError(parsed.error)}`,
    );
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}
