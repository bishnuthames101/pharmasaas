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
 * Pharmacy settings.
 *
 * The rules that matter are the ones with consequences elsewhere: the expiry
 * board reads `expiry_alert_days` positionally, the POS reads tax mode and
 * rate, and the invoice counter is load-bearing for a uniqueness constraint
 * that fails a sale at the counter if it is wrong.
 */
describe('settings', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;

  beforeAll(async () => {
    alpha = await seedPharmacy('set-a');
    beta = await seedPharmacy('set-b');
  }, 120_000);

  afterAll(async () => {
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  describe('who may change what', () => {
    it('lets an owner update every editable field', async () => {
      const { error } = await alpha.owner.client
        .from('settings')
        .update({
          pharmacy_name: 'Renamed Pharmacy',
          address: 'New Road, Kathmandu',
          phone: '01-5551234',
          currency: 'NPR',
          tax_mode: 'inclusive',
          default_tax_rate: 10,
          invoice_prefix: 'BILL',
          expiry_alert_days: [15, 45, 120],
          low_stock_threshold_default: 25,
        })
        .eq('tenant_id', alpha.tenant.id);

      expect(error, error?.message).toBeNull();

      const { data } = await admin
        .from('settings')
        .select('pharmacy_name, tax_mode, invoice_prefix, expiry_alert_days')
        .eq('tenant_id', alpha.tenant.id)
        .single();

      expect(data!.pharmacy_name).toBe('Renamed Pharmacy');
      expect(data!.tax_mode).toBe('inclusive');
      expect(data!.invoice_prefix).toBe('BILL');
      expect(data!.expiry_alert_days).toEqual([15, 45, 120]);
    });

    it('refuses a pharmacist', async () => {
      const { data } = await alpha.pharmacist.client
        .from('settings')
        .update({ pharmacy_name: 'Pharmacist Was Here' })
        .eq('tenant_id', alpha.tenant.id)
        .select();

      expect(data ?? []).toEqual([]);
    });

    it('refuses a cashier, who can still read', async () => {
      const { data: readable } = await alpha.cashier.client
        .from('settings')
        .select('currency, tax_mode');
      // The POS needs these, so reading is correct.
      expect(readable).toHaveLength(1);

      const { data: written } = await alpha.cashier.client
        .from('settings')
        .update({ default_tax_rate: 0 })
        .eq('tenant_id', alpha.tenant.id)
        .select();
      expect(written ?? []).toEqual([]);
    });

    it("refuses another pharmacy's owner", async () => {
      await beta.owner.client
        .from('settings')
        .update({ pharmacy_name: 'Hijacked' })
        .eq('tenant_id', alpha.tenant.id);

      const { data } = await admin
        .from('settings')
        .select('pharmacy_name')
        .eq('tenant_id', alpha.tenant.id)
        .single();
      expect(data!.pharmacy_name).not.toBe('Hijacked');
    });
  });

  describe('settings drive behaviour elsewhere', () => {
    it('changing tax mode and rate changes what the next sale charges', async () => {
      await admin
        .from('settings')
        .update({ tax_mode: 'exclusive', default_tax_rate: 20 })
        .eq('tenant_id', alpha.tenant.id);

      const med = await seedMedicine(alpha.tenant, { tax_rate: null });
      await seedBatch(alpha.tenant, med, {
        qty: 100,
        daysToExpiry: 200,
        sellingPrice: 100,
      });

      const { data: exclusive } = await alpha.cashier.client.rpc(
        'complete_sale',
        { p_payload: { items: [{ medicine_id: med, qty: 1 }] } },
      );
      expect(Number(exclusive.tax)).toBe(20);
      expect(Number(exclusive.total)).toBe(120);

      await admin
        .from('settings')
        .update({ tax_mode: 'inclusive' })
        .eq('tenant_id', alpha.tenant.id);

      const { data: inclusive } = await alpha.cashier.client.rpc(
        'complete_sale',
        { p_payload: { items: [{ medicine_id: med, qty: 1 }] } },
      );
      // The shelf price now contains the tax rather than attracting it.
      expect(Number(inclusive.total)).toBe(100);
      expect(Number(inclusive.tax)).toBeCloseTo(16.67, 1);
    });

    it('changing the invoice prefix affects only later sales', async () => {
      await admin
        .from('settings')
        .update({ invoice_prefix: 'NEW', tax_mode: 'exclusive' })
        .eq('tenant_id', alpha.tenant.id);

      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      await seedBatch(alpha.tenant, med, { qty: 10, daysToExpiry: 200 });

      const { data: sale } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 1 }] },
      });
      expect(sale.invoice_no).toMatch(/^NEW-/);

      // Earlier invoices keep the prefix they were issued under.
      const { data: older } = await admin
        .from('sales')
        .select('invoice_no')
        .eq('tenant_id', alpha.tenant.id)
        .like('invoice_no', 'BILL-%');
      expect(older!.length).toBeGreaterThan(0);
    });

    it('changing expiry thresholds re-buckets the expiry board', async () => {
      const med = await seedMedicine(alpha.tenant);
      await seedBatch(alpha.tenant, med, {
        qty: 10,
        daysToExpiry: 40,
        batchNo: 'BUCKET-TEST',
      });

      await admin
        .from('settings')
        .update({ expiry_alert_days: [30, 60, 90] })
        .eq('tenant_id', alpha.tenant.id);

      const { data: wide } = await alpha.owner.client
        .from('batch_expiry_board')
        .select('bucket')
        .eq('batch_no', 'BUCKET-TEST')
        .single();
      expect(wide!.bucket).toBe('warning');

      await admin
        .from('settings')
        .update({ expiry_alert_days: [50, 100, 200] })
        .eq('tenant_id', alpha.tenant.id);

      const { data: narrow } = await alpha.owner.client
        .from('batch_expiry_board')
        .select('bucket')
        .eq('batch_no', 'BUCKET-TEST')
        .single();
      // Same batch, same date — only the pharmacy's definition of "soon" moved.
      expect(narrow!.bucket).toBe('critical');
    });
  });

  describe('the invoice counter is load-bearing', () => {
    it('reissues a used number if moved backwards, failing the sale', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      await seedBatch(alpha.tenant, med, { qty: 50, daysToExpiry: 200 });

      const { data: first } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 1 }] },
      });
      const usedSeq = Number(first.invoice_no.split('-')[1]);

      // Force the counter back over a number already printed on a receipt.
      await admin
        .from('settings')
        .update({ next_invoice_seq: usedSeq })
        .eq('tenant_id', alpha.tenant.id);

      const { error } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 1 }] },
      });

      // This is exactly the failure the UI refuses to let an owner cause:
      // `unique (tenant_id, invoice_no)` rejects the sale at the counter.
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/duplicate key|unique/i);

      // Restore so later assertions are not affected.
      await admin
        .from('settings')
        .update({ next_invoice_seq: usedSeq + 1 })
        .eq('tenant_id', alpha.tenant.id);
    });

    it('accepts being moved forward, leaving a deliberate gap', async () => {
      const { data: before } = await admin
        .from('settings')
        .select('next_invoice_seq')
        .eq('tenant_id', alpha.tenant.id)
        .single();

      const jumped = Number(before!.next_invoice_seq) + 500;
      await alpha.owner.client
        .from('settings')
        .update({ next_invoice_seq: jumped })
        .eq('tenant_id', alpha.tenant.id);

      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      await seedBatch(alpha.tenant, med, { qty: 10, daysToExpiry: 200 });

      const { data: sale, error } = await alpha.cashier.client.rpc(
        'complete_sale',
        { p_payload: { items: [{ medicine_id: med, qty: 1 }] } },
      );

      expect(error, error?.message).toBeNull();
      expect(Number(sale.invoice_no.split('-')[1])).toBe(jumped);
    });
  });

  describe('the settings row itself', () => {
    it('cannot be deleted or duplicated', async () => {
      await alpha.owner.client
        .from('settings')
        .delete()
        .eq('tenant_id', alpha.tenant.id);

      const { count } = await admin
        .from('settings')
        .select('tenant_id', { count: 'exact', head: true })
        .eq('tenant_id', alpha.tenant.id);
      expect(count).toBe(1);

      const { error } = await alpha.owner.client
        .from('settings')
        .insert({ tenant_id: alpha.tenant.id, pharmacy_name: 'Second row' });
      expect(error).not.toBeNull();
    });
  });
});
