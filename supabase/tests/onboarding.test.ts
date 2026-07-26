import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  admin,
  cleanup,
  createTenant,
  createUser,
  type TestTenant,
  type TestUser,
} from './helpers';
import { RESERVED_SLUGS } from '../../src/lib/tenant/subdomain';

/**
 * Onboarding: slug rules, transactional provisioning, and the settings table.
 */
describe('onboarding', () => {
  const tenants: TestTenant[] = [];
  const users: TestUser[] = [];

  afterAll(async () => {
    await cleanup(tenants, users);
  });

  describe('reserved slugs', () => {
    it('the database list matches the list the proxy routes with', async () => {
      const { data } = await admin.from('reserved_slugs').select('slug');
      const dbSlugs = new Set((data ?? []).map((r) => r.slug as string));

      // Two copies exist because the proxy must resolve routes without a
      // database round trip. They must not drift: a slug reserved in only one
      // place is either registrable-but-unroutable, or routable-but-blocked.
      const onlyInDb = [...dbSlugs].filter((s) => !RESERVED_SLUGS.has(s));
      const onlyInApp = [...RESERVED_SLUGS].filter((s) => !dbSlugs.has(s));

      expect(onlyInDb, 'reserved in DB but not in subdomain.ts').toEqual([]);
      expect(onlyInApp, 'reserved in subdomain.ts but not in DB').toEqual([]);
    });
  });

  describe('slug_available', () => {
    it('rejects reserved slugs', async () => {
      const { data } = await admin.rpc('slug_available', { p_slug: 'admin' });
      expect(data).toBe(false);
    });

    it('rejects malformed slugs', async () => {
      for (const bad of ['a', 'Upper', 'has_underscore', '-lead', 'trail-']) {
        const { data } = await admin.rpc('slug_available', { p_slug: bad });
        expect(data, `expected "${bad}" to be rejected`).toBe(false);
      }
    });

    it('accepts a well-formed unused slug, then rejects it once taken', async () => {
      const slug = `avail-${randomUUID().slice(0, 8)}`;

      const { data: before } = await admin.rpc('slug_available', {
        p_slug: slug,
      });
      expect(before).toBe(true);

      const { data: row } = await admin
        .from('tenants')
        .insert({ slug, name: 'Taken' })
        .select('id')
        .single();
      tenants.push({ id: row!.id as string, slug, name: 'Taken' });

      const { data: after } = await admin.rpc('slug_available', {
        p_slug: slug,
      });
      expect(after).toBe(false);
    });
  });

  describe('provision_tenant', () => {
    it('creates the tenant, owner membership and settings together', async () => {
      const email = `owner-${randomUUID()}@example.test`;
      const { data: created } = await admin.auth.admin.createUser({
        email,
        password: `Pw-${randomUUID()}`,
        email_confirm: true,
      });
      const ownerId = created.user!.id;

      const slug = `prov-${randomUUID().slice(0, 8)}`;
      const { data: tenant, error } = await admin.rpc('provision_tenant', {
        p_slug: slug,
        p_name: 'Provisioned Pharmacy',
        p_owner_id: ownerId,
        p_phone: '+977-1-4000000',
        p_address: 'Kathmandu',
      });

      expect(error, error?.message).toBeNull();
      const tenantId = (tenant as { id: string }).id;
      tenants.push({ id: tenantId, slug, name: 'Provisioned Pharmacy' });

      const { data: membership } = await admin
        .from('tenant_users')
        .select('role, is_active')
        .eq('tenant_id', tenantId)
        .single();
      expect(membership!.role).toBe('owner');
      expect(membership!.is_active).toBe(true);

      const { data: settings } = await admin
        .from('settings')
        .select('pharmacy_name, currency, default_tax_rate, next_invoice_seq')
        .eq('tenant_id', tenantId)
        .single();

      expect(settings!.pharmacy_name).toBe('Provisioned Pharmacy');
      expect(settings!.currency).toBe('NPR');
      expect(Number(settings!.default_tax_rate)).toBe(13);
      expect(Number(settings!.next_invoice_seq)).toBe(1);

      await admin.auth.admin.deleteUser(ownerId).catch(() => {});
    });

    it('leaves nothing behind when the slug is unavailable', async () => {
      const { count: before } = await admin
        .from('tenants')
        .select('id', { count: 'exact', head: true });

      const { error } = await admin.rpc('provision_tenant', {
        p_slug: 'admin',
        p_name: 'Should Not Exist',
        p_owner_id: randomUUID(),
      });

      expect(error).not.toBeNull();

      const { count: after } = await admin
        .from('tenants')
        .select('id', { count: 'exact', head: true });

      expect(after).toBe(before);
    });

    it('is not callable by a tenant user', async () => {
      const tenant = await createTenant('nocall');
      tenants.push(tenant);
      const owner = await createUser(tenant, 'owner');
      users.push(owner);

      const { error } = await owner.client.rpc('provision_tenant', {
        p_slug: `sneaky-${randomUUID().slice(0, 6)}`,
        p_name: 'Sneaky',
        p_owner_id: owner.user.id,
      });

      expect(error).not.toBeNull();
    });
  });

  describe('settings isolation and role gates', () => {
    let alpha: TestTenant;
    let beta: TestTenant;
    let alphaOwner: TestUser;
    let alphaCashier: TestUser;
    let betaOwner: TestUser;

    beforeAll(async () => {
      alpha = await createTenant('alpha');
      beta = await createTenant('beta');
      tenants.push(alpha, beta);

      // createTenant inserts directly, so seed the settings rows the way
      // provision_tenant would.
      await admin.from('settings').insert([
        { tenant_id: alpha.id, pharmacy_name: 'Alpha' },
        { tenant_id: beta.id, pharmacy_name: 'Beta' },
      ]);

      alphaOwner = await createUser(alpha, 'owner');
      alphaCashier = await createUser(alpha, 'cashier');
      betaOwner = await createUser(beta, 'owner');
      users.push(alphaOwner, alphaCashier, betaOwner);
    });

    it('shows a pharmacy only its own settings', async () => {
      const { data } = await alphaOwner.client
        .from('settings')
        .select('tenant_id, pharmacy_name');

      expect(data).toHaveLength(1);
      expect(data![0].tenant_id).toBe(alpha.id);
    });

    it("does not return another pharmacy's settings even when asked directly", async () => {
      const { data } = await alphaOwner.client
        .from('settings')
        .select('pharmacy_name')
        .eq('tenant_id', beta.id);

      expect(data).toEqual([]);
    });

    it('lets an owner update their own settings', async () => {
      const { error } = await alphaOwner.client
        .from('settings')
        .update({ invoice_prefix: 'ALP' })
        .eq('tenant_id', alpha.id);

      expect(error).toBeNull();

      const { data } = await admin
        .from('settings')
        .select('invoice_prefix')
        .eq('tenant_id', alpha.id)
        .single();

      expect(data!.invoice_prefix).toBe('ALP');
    });

    it('refuses settings updates by a cashier', async () => {
      const { data } = await alphaCashier.client
        .from('settings')
        .update({ invoice_prefix: 'HACK' })
        .eq('tenant_id', alpha.id)
        .select();

      expect(data ?? []).toEqual([]);

      const { data: after } = await admin
        .from('settings')
        .select('invoice_prefix')
        .eq('tenant_id', alpha.id)
        .single();

      expect(after!.invoice_prefix).not.toBe('HACK');
    });

    it("refuses to update another pharmacy's settings", async () => {
      await betaOwner.client
        .from('settings')
        .update({ invoice_prefix: 'STOLEN' })
        .eq('tenant_id', alpha.id);

      const { data: after } = await admin
        .from('settings')
        .select('invoice_prefix')
        .eq('tenant_id', alpha.id)
        .single();

      expect(after!.invoice_prefix).not.toBe('STOLEN');
    });

    it('refuses to insert or delete settings rows at all', async () => {
      const { error: insertError } = await alphaOwner.client
        .from('settings')
        .insert({ tenant_id: randomUUID(), pharmacy_name: 'Rogue' });
      expect(insertError).not.toBeNull();

      await alphaOwner.client
        .from('settings')
        .delete()
        .eq('tenant_id', alpha.id);

      const { count } = await admin
        .from('settings')
        .select('tenant_id', { count: 'exact', head: true })
        .eq('tenant_id', alpha.id);
      expect(count).toBe(1);
    });
  });

  /**
   * The signup and tenant-switch sequence, tested at the seam where it is
   * easiest to get wrong.
   *
   * `app_metadata` is baked into the access token when it is issued. Changing
   * it server-side has no effect on an existing session until that session
   * refreshes — so an implementation that stamps the claim but forgets to
   * refresh produces a user who is definitely signed in and can definitely see
   * nothing, with no error anywhere to explain why.
   */
  describe('JWT claim stamping', () => {
    it('sees nothing until the claim is stamped and the session refreshed', async () => {
      const email = `claim-${randomUUID()}@example.test`;
      const password = `Pw-${randomUUID()}`;

      const { data: created } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      const userId = created.user!.id;

      const slug = `claim-${randomUUID().slice(0, 8)}`;
      const { data: provisioned } = await admin.rpc('provision_tenant', {
        p_slug: slug,
        p_name: 'Claim Pharmacy',
        p_owner_id: userId,
      });
      const tenantId = (provisioned as { id: string }).id;
      tenants.push({ id: tenantId, slug, name: 'Claim Pharmacy' });

      const { createClient } = await import('@supabase/supabase-js');
      const client = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );

      // Signed in before the claim exists: a real owner, with a real
      // membership row, who can read nothing.
      await client.auth.signInWithPassword({ email, password });

      const { data: beforeStamp } = await client.from('settings').select('*');
      expect(beforeStamp).toEqual([]);

      const { data: tenantIdBefore } = await client.rpc('tenant_id');
      expect(tenantIdBefore).toBeNull();

      // Stamping alone changes nothing for the live session.
      await admin.auth.admin.updateUserById(userId, {
        app_metadata: { tenant_id: tenantId },
      });

      const { data: afterStampOnly } = await client
        .from('settings')
        .select('*');
      expect(
        afterStampOnly,
        'stamping without refreshing must not take effect',
      ).toEqual([]);

      // The refresh mints a new token carrying the claim.
      const { error: refreshError } = await client.auth.refreshSession();
      expect(refreshError).toBeNull();

      const { data: afterRefresh } = await client.from('settings').select('*');
      expect(afterRefresh).toHaveLength(1);
      expect(afterRefresh![0].tenant_id).toBe(tenantId);

      await admin.auth.admin.deleteUser(userId).catch(() => {});
    });

    it('switches which pharmacy a two-pharmacy user can see', async () => {
      const first = await createTenant('switch-a');
      const second = await createTenant('switch-b');
      tenants.push(first, second);

      await admin.from('settings').insert([
        { tenant_id: first.id, pharmacy_name: 'First' },
        { tenant_id: second.id, pharmacy_name: 'Second' },
      ]);

      // Member of both, active claim on the first.
      const user = await createUser(first, 'owner');
      users.push(user);
      await admin
        .from('tenant_users')
        .insert({ tenant_id: second.id, user_id: user.user.id, role: 'owner' });

      const { data: onFirst } = await user.client
        .from('settings')
        .select('pharmacy_name');
      expect(onFirst).toHaveLength(1);
      expect(onFirst![0].pharmacy_name).toBe('First');

      await admin.auth.admin.updateUserById(user.user.id, {
        app_metadata: { tenant_id: second.id },
      });
      await user.client.auth.refreshSession();

      const { data: onSecond } = await user.client
        .from('settings')
        .select('pharmacy_name');
      expect(onSecond).toHaveLength(1);
      expect(onSecond![0].pharmacy_name).toBe('Second');
    });

    it('refuses a claim pointing at a pharmacy the user does not belong to', async () => {
      const home = await createTenant('home');
      const foreign = await createTenant('foreign');
      tenants.push(home, foreign);

      await admin
        .from('settings')
        .insert([{ tenant_id: foreign.id, pharmacy_name: 'Foreign' }]);

      const user = await createUser(home, 'owner');
      users.push(user);

      // Forge the claim the way a compromised admin path might. The claim is
      // only half the check: policies on role-gated writes call tenant_role(),
      // which finds no membership row and returns null.
      await admin.auth.admin.updateUserById(user.user.id, {
        app_metadata: { tenant_id: foreign.id },
      });
      await user.client.auth.refreshSession();

      const { data: role } = await user.client.rpc('tenant_role');
      expect(role).toBeNull();

      const { data: updated } = await user.client
        .from('settings')
        .update({ invoice_prefix: 'FORGED' })
        .eq('tenant_id', foreign.id)
        .select();
      expect(updated ?? []).toEqual([]);

      const { data: after } = await admin
        .from('settings')
        .select('invoice_prefix')
        .eq('tenant_id', foreign.id)
        .single();
      expect(after!.invoice_prefix).toBe('INV');
    });
  });

  describe('admin helper functions', () => {
    it('resolves a user id by email for the service role', async () => {
      const tenant = await createTenant('lookup');
      tenants.push(tenant);
      const user = await createUser(tenant, 'owner');
      users.push(user);

      const { data } = await admin.rpc('user_id_by_email', {
        p_email: user.email.toUpperCase(),
      });

      expect(data).toBe(user.user.id);
    });

    it('does not expose the email lookup to tenant users', async () => {
      const tenant = await createTenant('nolookup');
      tenants.push(tenant);
      const user = await createUser(tenant, 'owner');
      users.push(user);

      const { error } = await user.client.rpc('user_id_by_email', {
        p_email: user.email,
      });

      expect(error).not.toBeNull();
    });

    it('does not expose session revocation to tenant users', async () => {
      const tenant = await createTenant('norevoke');
      tenants.push(tenant);
      const user = await createUser(tenant, 'owner');
      users.push(user);

      const { error } = await user.client.rpc('revoke_user_sessions', {
        p_user_id: user.user.id,
      });

      expect(error).not.toBeNull();
    });

    it('revokes sessions so a refresh token can no longer be used', async () => {
      const tenant = await createTenant('revoked');
      tenants.push(tenant);
      const user = await createUser(tenant, 'cashier');
      users.push(user);

      const { data: revoked } = await admin.rpc('revoke_user_sessions', {
        p_user_id: user.user.id,
      });
      expect(revoked).toBeGreaterThan(0);

      // The access token stays valid until it expires — revocation cannot
      // recall an already-issued bearer token — but the session is gone, so it
      // can never be extended.
      const { error } = await user.client.auth.refreshSession();
      expect(error).not.toBeNull();
    });
  });
});
