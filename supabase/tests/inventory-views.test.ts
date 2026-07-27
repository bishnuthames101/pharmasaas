import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  cleanupPharmacy,
  seedBatch,
  seedMedicine,
  seedPharmacy,
  type SeededPharmacy,
} from './helpers';

/**
 * The inventory read models.
 *
 * Views are the quiet failure mode in a Postgres RLS design: without
 * `security_invoker = true` they execute as their owner and hand back every
 * tenant's rows with no error to hint at it. The coverage gate now flags that
 * statically; these tests confirm the behaviour at runtime.
 */
describe('inventory views', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;
  let alphaMedicine: string;

  beforeAll(async () => {
    alpha = await seedPharmacy('inv-a');
    beta = await seedPharmacy('inv-b');

    alphaMedicine = await seedMedicine(alpha.tenant, {
      name: 'Alpha Paracetamol',
      generic_name: 'paracetamol',
      min_stock: 100,
      unit: 'tablet',
    });
    await seedBatch(alpha.tenant, alphaMedicine, {
      qty: 40,
      daysToExpiry: 20,
      batchNo: 'A-SOON',
    });
    await seedBatch(alpha.tenant, alphaMedicine, {
      qty: 10,
      daysToExpiry: -5,
      batchNo: 'A-EXPIRED',
    });

    const betaMedicine = await seedMedicine(beta.tenant, {
      name: 'Beta Amoxicillin',
      generic_name: 'amoxicillin',
    });
    await seedBatch(beta.tenant, betaMedicine, {
      qty: 500,
      daysToExpiry: 300,
      batchNo: 'B-ONLY',
    });
  }, 120_000);

  afterAll(async () => {
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  describe('medicine_stock', () => {
    it('aggregates saleable and expired stock separately', async () => {
      const { data } = await alpha.owner.client
        .from('medicine_stock')
        .select('*')
        .eq('id', alphaMedicine)
        .single();

      // Expired units are physically present and still need writing off, so
      // they are counted apart rather than silently dropped.
      expect(Number(data!.stock_on_hand)).toBe(50);
      expect(Number(data!.saleable_on_hand)).toBe(40);
      expect(Number(data!.expired_on_hand)).toBe(10);
      expect(Number(data!.batch_count)).toBe(2);
    });

    it('flags low stock against min_stock', async () => {
      const { data } = await alpha.owner.client
        .from('medicine_stock')
        .select('is_low_stock')
        .eq('id', alphaMedicine)
        .single();

      // 40 saleable against a minimum of 100.
      expect(data!.is_low_stock).toBe(true);
    });

    it('never returns another pharmacy rows', async () => {
      const { data } = await alpha.owner.client
        .from('medicine_stock')
        .select('name');

      const names = (data ?? []).map((r) => r.name);
      expect(names).toContain('Alpha Paracetamol');
      expect(names).not.toContain('Beta Amoxicillin');
    });

    it('returns nothing when asked for another pharmacy row directly', async () => {
      const { data: betaRows } = await admin
        .from('medicines')
        .select('id')
        .eq('tenant_id', beta.tenant.id);

      const { data } = await alpha.owner.client
        .from('medicine_stock')
        .select('name')
        .eq('id', betaRows![0].id);

      expect(data ?? []).toEqual([]);
    });

    it('is visible to a cashier, who needs it to sell', async () => {
      const { data } = await alpha.cashier.client
        .from('medicine_stock')
        .select('name, saleable_on_hand');

      expect(data!.length).toBeGreaterThan(0);
      // The view exposes no cost column at all, to any role.
      expect(Object.keys(data![0])).not.toContain('cost_price');
    });
  });

  describe('batch_expiry_board', () => {
    it('buckets by the pharmacy own alert thresholds', async () => {
      const { data } = await alpha.owner.client
        .from('batch_expiry_board')
        .select('batch_no, bucket, days_to_expiry')
        .order('expiry_date');

      const byBatch = new Map(
        (data ?? []).map((r) => [r.batch_no as string, r]),
      );

      expect(byBatch.get('A-EXPIRED')!.bucket).toBe('expired');
      // 20 days out, against a default first threshold of 30.
      expect(byBatch.get('A-SOON')!.bucket).toBe('critical');
    });

    it('honours a changed expiry_alert_days setting', async () => {
      await admin
        .from('settings')
        .update({ expiry_alert_days: [7, 14, 21] })
        .eq('tenant_id', alpha.tenant.id);

      const { data } = await alpha.owner.client
        .from('batch_expiry_board')
        .select('batch_no, bucket')
        .eq('batch_no', 'A-SOON')
        .single();

      // Same batch, 20 days out: no longer critical under a 7/14/21 window.
      expect(data!.bucket).toBe('notice');

      await admin
        .from('settings')
        .update({ expiry_alert_days: [30, 60, 90] })
        .eq('tenant_id', alpha.tenant.id);
    });

    it("does not show another pharmacy's batches", async () => {
      const { data } = await alpha.owner.client
        .from('batch_expiry_board')
        .select('batch_no');

      const batches = (data ?? []).map((r) => r.batch_no);
      expect(batches).not.toContain('B-ONLY');
    });
  });

  describe('log_audit', () => {
    it('attributes entries to the caller and their own pharmacy', async () => {
      const { error } = await alpha.pharmacist.client.rpc('log_audit', {
        p_action: 'medicine.update',
        p_entity: 'medicines',
        p_entity_id: alphaMedicine,
        p_after: { name: 'Changed' },
      });
      expect(error, error?.message).toBeNull();

      const { data } = await admin
        .from('audit_log')
        .select('tenant_id, actor, action')
        .eq('tenant_id', alpha.tenant.id)
        .eq('action', 'medicine.update');

      expect(data!.length).toBeGreaterThan(0);
      expect(data![0].actor).toBe(alpha.pharmacist.user.id);
    });

    it('is readable by an owner but not by a cashier', async () => {
      const { data: ownerView } = await alpha.owner.client
        .from('audit_log')
        .select('action');
      expect(ownerView!.length).toBeGreaterThan(0);

      const { data: cashierView } = await alpha.cashier.client
        .from('audit_log')
        .select('action');
      expect(cashierView ?? []).toEqual([]);
    });

    it('cannot be written to directly, even by an owner', async () => {
      const { error } = await alpha.owner.client.from('audit_log').insert({
        tenant_id: alpha.tenant.id,
        action: 'forged.entry',
      });

      // An audit trail that subjects can edit is not an audit trail.
      expect(error).not.toBeNull();
    });
  });
});
