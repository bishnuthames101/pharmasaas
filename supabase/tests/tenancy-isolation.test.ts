import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  cleanup,
  createTenant,
  createUser,
  type TestTenant,
  type TestUser,
} from './helpers';

/**
 * Cross-tenant isolation on the tenancy core.
 *
 * Two pharmacies, one owner each. Every assertion below is a leak that would be
 * a platform-wide breach if it succeeded, so they are written as "this must
 * return nothing / must fail", not "this returns the right thing".
 */
describe('tenancy core isolation', () => {
  let sunrise: TestTenant;
  let moon: TestTenant;
  let sunriseOwner: TestUser;
  let moonOwner: TestUser;

  beforeAll(async () => {
    sunrise = await createTenant('sunrise');
    moon = await createTenant('moon');
    sunriseOwner = await createUser(sunrise, 'owner');
    moonOwner = await createUser(moon, 'owner');
  });

  afterAll(async () => {
    await cleanup([sunrise, moon], [sunriseOwner, moonOwner]);
  });

  describe('tenants', () => {
    it('lets an owner read their own pharmacy', async () => {
      const { data } = await sunriseOwner.client
        .from('tenants')
        .select('id, name')
        .eq('id', sunrise.id);

      expect(data).toHaveLength(1);
      expect(data![0].id).toBe(sunrise.id);
    });

    it("does not return another pharmacy's row", async () => {
      const { data } = await sunriseOwner.client
        .from('tenants')
        .select('id')
        .eq('id', moon.id);

      expect(data).toEqual([]);
    });

    it('does not leak other pharmacies through an unfiltered select', async () => {
      const { data } = await sunriseOwner.client.from('tenants').select('id');
      const ids = (data ?? []).map((row) => row.id);

      expect(ids).toContain(sunrise.id);
      expect(ids).not.toContain(moon.id);
    });

    it('refuses to rename another pharmacy', async () => {
      const { data } = await sunriseOwner.client
        .from('tenants')
        .update({ name: 'Hijacked' })
        .eq('id', moon.id)
        .select();

      // RLS makes the row invisible, so the update matches nothing rather than
      // raising — the row must be unchanged either way.
      expect(data ?? []).toEqual([]);

      const { data: after } = await admin
        .from('tenants')
        .select('name')
        .eq('id', moon.id)
        .single();

      expect(after!.name).not.toBe('Hijacked');
    });

    it('refuses to delete any pharmacy, including its own', async () => {
      await sunriseOwner.client.from('tenants').delete().eq('id', sunrise.id);

      const { data: still } = await admin
        .from('tenants')
        .select('id')
        .eq('id', sunrise.id);

      expect(still).toHaveLength(1);
    });
  });

  describe('tenant_users', () => {
    it("lists its own pharmacy's staff", async () => {
      const { data } = await sunriseOwner.client
        .from('tenant_users')
        .select('user_id, role');

      expect(data).toHaveLength(1);
      expect(data![0].user_id).toBe(sunriseOwner.user.id);
    });

    it("does not return another pharmacy's staff", async () => {
      const { data } = await sunriseOwner.client
        .from('tenant_users')
        .select('user_id')
        .eq('tenant_id', moon.id);

      expect(data).toEqual([]);
    });

    it('refuses to grant itself membership in another pharmacy', async () => {
      const { error } = await sunriseOwner.client.from('tenant_users').insert({
        tenant_id: moon.id,
        user_id: sunriseOwner.user.id,
        role: 'owner',
      });

      expect(error).not.toBeNull();

      const { data: members } = await admin
        .from('tenant_users')
        .select('user_id')
        .eq('tenant_id', moon.id);

      expect(members).toHaveLength(1);
      expect(members![0].user_id).toBe(moonOwner.user.id);
    });

    it("refuses to change another pharmacy's staff roles", async () => {
      const { data } = await sunriseOwner.client
        .from('tenant_users')
        .update({ role: 'cashier' })
        .eq('tenant_id', moon.id)
        .select();

      expect(data ?? []).toEqual([]);

      const { data: after } = await admin
        .from('tenant_users')
        .select('role')
        .eq('tenant_id', moon.id)
        .eq('user_id', moonOwner.user.id)
        .single();

      expect(after!.role).toBe('owner');
    });

    it("refuses to remove another pharmacy's staff", async () => {
      await sunriseOwner.client
        .from('tenant_users')
        .delete()
        .eq('tenant_id', moon.id);

      const { data: after } = await admin
        .from('tenant_users')
        .select('user_id')
        .eq('tenant_id', moon.id);

      expect(after).toHaveLength(1);
    });
  });

  describe('helper functions', () => {
    it("resolves the caller's own tenant and role", async () => {
      const { data: tenantId } = await sunriseOwner.client.rpc('tenant_id');
      const { data: role } = await sunriseOwner.client.rpc('tenant_role');

      expect(tenantId).toBe(sunrise.id);
      expect(role).toBe('owner');
    });

    it('reports no membership in a pharmacy the caller does not belong to', async () => {
      const { data } = await sunriseOwner.client.rpc('is_tenant_member', {
        p_tenant_id: moon.id,
      });

      expect(data).toBe(false);
    });

    it('does not expose the coverage report to tenant users', async () => {
      const { error } = await sunriseOwner.client.rpc('rls_coverage_gaps');
      expect(error).not.toBeNull();
    });
  });

  describe('deactivated membership', () => {
    it('loses role-gated write access immediately, without a token refresh', async () => {
      const cashier = await createUser(sunrise, 'cashier');

      try {
        await admin
          .from('tenant_users')
          .update({ is_active: false })
          .eq('tenant_id', sunrise.id)
          .eq('user_id', cashier.user.id);

        // The JWT still says "member of sunrise" — it was minted before the
        // change and nothing has refreshed it. tenant_role() re-reads
        // tenant_users, so the write is refused anyway. This is precisely why
        // role gates must not be decided from the token alone.
        const { error } = await cashier.client.from('tenant_users').insert({
          tenant_id: sunrise.id,
          user_id: cashier.user.id,
          role: 'owner',
        });

        expect(error).not.toBeNull();
      } finally {
        await admin.auth.admin.deleteUser(cashier.user.id).catch(() => {});
      }
    });
  });
});
