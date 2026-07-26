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

export interface SeededPharmacy {
  tenant: TestTenant;
  owner: TestUser;
  pharmacist: TestUser;
  cashier: TestUser;
}

/**
 * A pharmacy provisioned the way signup does it, with one user per role.
 *
 * Uses `provision_tenant` rather than raw inserts so the settings row (and
 * therefore the invoice counter) exists, which every sale depends on.
 */
export async function seedPharmacy(label: string): Promise<SeededPharmacy> {
  const slug = `dom-${label}-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `owner-${randomUUID()}@example.test`;
  const password = `Pw-${randomUUID()}`;

  const { data: createdOwner, error: ownerError } =
    await admin.auth.admin.createUser({
      email: ownerEmail,
      password,
      email_confirm: true,
    });
  if (ownerError) throw new Error(`seed owner failed: ${ownerError.message}`);

  const { data: provisioned, error: provisionError } = await admin.rpc(
    'provision_tenant',
    {
      p_slug: slug,
      p_name: `Test ${label}`,
      p_owner_id: createdOwner.user!.id,
    },
  );
  if (provisionError) {
    throw new Error(`provision failed: ${provisionError.message}`);
  }

  const tenant: TestTenant = {
    id: (provisioned as { id: string }).id,
    slug,
    name: `Test ${label}`,
  };

  // The owner already has a membership from provisioning, so stamp and sign in
  // rather than going through createUser (which would insert a second row).
  await admin.auth.admin.updateUserById(createdOwner.user!.id, {
    app_metadata: { tenant_id: tenant.id },
  });

  const ownerClient = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await ownerClient.auth.signInWithPassword({
    email: ownerEmail,
    password,
  });
  if (signInError)
    throw new Error(`seed sign-in failed: ${signInError.message}`);

  return {
    tenant,
    owner: {
      user: createdOwner.user!,
      email: ownerEmail,
      password,
      client: ownerClient,
    },
    pharmacist: await createUser(tenant, 'pharmacist'),
    cashier: await createUser(tenant, 'cashier'),
  };
}

/** Create a medicine directly (bypassing RLS) and return its id. */
export async function seedMedicine(
  tenant: TestTenant,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await admin
    .from('medicines')
    .insert({
      tenant_id: tenant.id,
      name: `Med ${randomUUID().slice(0, 6)}`,
      units_per_pack: 10,
      ...overrides,
    })
    .select('id')
    .single();

  if (error) throw new Error(`seedMedicine failed: ${error.message}`);
  return data!.id as string;
}

/**
 * Create a batch with a given expiry and quantity.
 * `daysToExpiry` may be negative to produce already-expired stock.
 */
export async function seedBatch(
  tenant: TestTenant,
  medicineId: string,
  opts: {
    qty: number;
    daysToExpiry: number;
    sellingPrice?: number;
    costPrice?: number;
    batchNo?: string;
  },
): Promise<string> {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + opts.daysToExpiry);

  const { data, error } = await admin
    .from('batches')
    .insert({
      tenant_id: tenant.id,
      medicine_id: medicineId,
      batch_no: opts.batchNo ?? `B-${randomUUID().slice(0, 6)}`,
      expiry_date: expiry.toISOString().slice(0, 10),
      qty_available: opts.qty,
      selling_price: opts.sellingPrice ?? 100,
    })
    .select('id')
    .single();

  if (error) throw new Error(`seedBatch failed: ${error.message}`);
  const batchId = data!.id as string;

  await admin.from('batch_costs').insert({
    batch_id: batchId,
    tenant_id: tenant.id,
    cost_price: opts.costPrice ?? 60,
  });

  return batchId;
}

/** Tear down a seeded pharmacy and all three of its users. */
export async function cleanupPharmacy(p: SeededPharmacy) {
  await cleanup([p.tenant], [p.owner, p.pharmacist, p.cashier]);
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
