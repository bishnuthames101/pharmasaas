import {
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

/**
 * Test harness for the RLS suite.
 *
 * These tests run against a real Postgres, because RLS is a database feature —
 * mocking the client would test nothing. Fixtures are namespaced with a random
 * run id and torn down afterwards so concurrent runs cannot collide.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'The RLS suite needs real Supabase credentials. Fill in .env.local ' +
      '(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, ' +
      'SUPABASE_SERVICE_ROLE_KEY) before running `pnpm test:rls`.',
  );
}

/** Service-role client: bypasses RLS. Used only to build and tear down fixtures. */
export const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export interface TestUser {
  user: User;
  email: string;
  password: string;
  /** Anon-key client carrying this user's session — subject to RLS. */
  client: SupabaseClient;
}

export interface TestTenant {
  id: string;
  slug: string;
  name: string;
}

/** Create a pharmacy directly, bypassing the (not yet built) signup flow. */
export async function createTenant(label: string): Promise<TestTenant> {
  const slug = `test-${label}-${randomUUID().slice(0, 8)}`;

  const { data, error } = await admin
    .from('tenants')
    .insert({ slug, name: `Test ${label}` })
    .select('id, slug, name')
    .single();

  if (error) throw new Error(`createTenant failed: ${error.message}`);
  return data as TestTenant;
}

/**
 * Create a confirmed user, make them a member of `tenant`, stamp their active
 * tenant into `app_metadata`, and sign them in.
 *
 * The claim must be stamped *before* sign-in: the JWT is minted at sign-in, so
 * a later metadata change would not appear until the session refreshed — the
 * same staleness the application has to handle in production.
 */
export async function createUser(
  tenant: TestTenant,
  role: 'owner' | 'pharmacist' | 'cashier',
): Promise<TestUser> {
  const email = `rls-${randomUUID()}@example.test`;
  const password = `Pw-${randomUUID()}`;

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { tenant_id: tenant.id },
    });

  if (createError) throw new Error(`createUser failed: ${createError.message}`);
  const user = created.user!;

  const { error: memberError } = await admin
    .from('tenant_users')
    .insert({ tenant_id: tenant.id, user_id: user.id, role });

  if (memberError) {
    throw new Error(`membership insert failed: ${memberError.message}`);
  }

  const client = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

  return { user, email, password, client };
}

/** Remove every fixture created by a run. Safe to call more than once. */
export async function cleanup(tenants: TestTenant[], users: TestUser[]) {
  for (const user of users) {
    await admin.auth.admin.deleteUser(user.user.id).catch(() => {});
  }
  for (const tenant of tenants) {
    // Memberships and domain rows cascade from the tenant.
    await admin.from('tenants').delete().eq('id', tenant.id);
  }
}
