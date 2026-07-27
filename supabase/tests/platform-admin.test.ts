import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  cleanupPharmacy,
  seedPharmacy,
  type SeededPharmacy,
} from './helpers';

/**
 * The platform-admin surface.
 *
 * This is the only code that legitimately sees across tenants, so the tests
 * here are about what an ordinary user *cannot* do: read the operator list,
 * add themselves to it, enumerate other pharmacies, or suspend anyone.
 */
describe('platform admin', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;

  beforeAll(async () => {
    alpha = await seedPharmacy('plat-a');
    beta = await seedPharmacy('plat-b');
  }, 120_000);

  afterAll(async () => {
    await admin
      .from('platform_admins')
      .delete()
      .eq('user_id', alpha.owner.user.id);
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  describe('platform_admins is unreachable from the application', () => {
    it('cannot be read by a tenant owner', async () => {
      const { data } = await alpha.owner.client
        .from('platform_admins')
        .select('user_id');
      expect(data ?? []).toEqual([]);
    });

    it('cannot be written to, so nobody can promote themselves', async () => {
      const { error } = await alpha.owner.client
        .from('platform_admins')
        .insert({ user_id: alpha.owner.user.id, email: alpha.owner.email });

      // The table has no policies at all. Adding a row takes a migration or the
      // Supabase dashboard — never a request.
      expect(error).not.toBeNull();

      const { data: check } = await admin
        .from('platform_admins')
        .select('user_id')
        .eq('user_id', alpha.owner.user.id);
      expect(check ?? []).toEqual([]);
    });
  });

  describe('platform functions are service-role only', () => {
    it('refuses the tenant overview to a tenant owner', async () => {
      const { error } = await alpha.owner.client.rpc(
        'platform_tenant_overview',
      );
      expect(error).not.toBeNull();
    });

    it('refuses suspension to a tenant owner', async () => {
      const { error } = await alpha.owner.client.rpc(
        'platform_set_tenant_status',
        { p_tenant_id: beta.tenant.id, p_status: 'suspended' },
      );
      expect(error).not.toBeNull();

      const { data: after } = await admin
        .from('tenants')
        .select('status')
        .eq('id', beta.tenant.id)
        .single();
      expect(after!.status).toBe('active');
    });

    it("refuses an owner suspending their own pharmacy's rival", async () => {
      const { error } = await beta.owner.client.rpc(
        'platform_set_tenant_status',
        { p_tenant_id: alpha.tenant.id, p_status: 'suspended' },
      );
      expect(error).not.toBeNull();
    });
  });

  describe('service-role operations', () => {
    it('reports counts across tenants without exposing records', async () => {
      const { data, error } = await admin.rpc('platform_tenant_overview');
      expect(error, error?.message).toBeNull();

      const rows = data as { id: string; slug: string; user_count: number }[];
      const ours = rows.find((r) => r.id === alpha.tenant.id);

      expect(ours).toBeTruthy();
      // owner, pharmacist, cashier
      expect(Number(ours!.user_count)).toBe(3);

      // The overview carries aggregates only — no medicine names, no customers.
      expect(Object.keys(rows[0])).toEqual(
        expect.arrayContaining(['slug', 'user_count', 'sale_count']),
      );
      expect(Object.keys(rows[0])).not.toContain('customers');
    });

    it('suspends and reactivates, writing to the tenant own audit log', async () => {
      await admin.rpc('platform_set_tenant_status', {
        p_tenant_id: alpha.tenant.id,
        p_status: 'suspended',
      });

      const { data: suspended } = await admin
        .from('tenants')
        .select('status')
        .eq('id', alpha.tenant.id)
        .single();
      expect(suspended!.status).toBe('suspended');

      // The pharmacy can see that it happened, in its own log.
      const { data: entries } = await admin
        .from('audit_log')
        .select('action, after')
        .eq('tenant_id', alpha.tenant.id)
        .eq('action', 'platform.tenant_status');

      expect(entries!.length).toBeGreaterThan(0);

      await admin.rpc('platform_set_tenant_status', {
        p_tenant_id: alpha.tenant.id,
        p_status: 'active',
      });

      const { data: active } = await admin
        .from('tenants')
        .select('status')
        .eq('id', alpha.tenant.id)
        .single();
      expect(active!.status).toBe('active');
    });

    it('rejects a status outside the allowed set', async () => {
      const { error } = await admin.rpc('platform_set_tenant_status', {
        p_tenant_id: alpha.tenant.id,
        p_status: 'deleted',
      });
      expect(error).not.toBeNull();
    });
  });

  describe('platform admin conveys nothing inside a tenant', () => {
    it('does not grant access to another pharmacy data', async () => {
      // Make alpha's owner a genuine platform admin.
      await admin.from('platform_admins').insert({
        user_id: alpha.owner.user.id,
        email: alpha.owner.email,
        note: 'test',
      });

      // Their ordinary session is unchanged: platform status is a separate
      // axis from tenant_users.role and carries no RLS weight.
      const { data: medicines } = await alpha.owner.client
        .from('medicines')
        .select('tenant_id');

      for (const row of medicines ?? []) {
        expect(row.tenant_id).toBe(alpha.tenant.id);
      }

      const { data: betaSettings } = await alpha.owner.client
        .from('settings')
        .select('tenant_id')
        .eq('tenant_id', beta.tenant.id);
      expect(betaSettings ?? []).toEqual([]);

      // Still cannot call the platform functions with an anon-key session.
      const { error } = await alpha.owner.client.rpc(
        'platform_tenant_overview',
      );
      expect(error).not.toBeNull();
    });
  });
});
