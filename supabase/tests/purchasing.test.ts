import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  cleanupPharmacy,
  seedMedicine,
  seedPharmacy,
  type SeededPharmacy,
} from './helpers';

/**
 * Purchasing: the supplier ledger and the reorder report.
 *
 * The ledger is the part worth guarding. A payment row and the balance it
 * settles are written by one function precisely so they cannot disagree, and a
 * cashier must not be able to move either.
 */
describe('purchasing', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;
  let supplierId: string;

  beforeAll(async () => {
    alpha = await seedPharmacy('buy-a');
    beta = await seedPharmacy('buy-b');

    const { data } = await admin
      .from('suppliers')
      .insert({ tenant_id: alpha.tenant.id, name: 'Kathmandu Distributors' })
      .select('id')
      .single();
    supplierId = data!.id as string;
  }, 120_000);

  afterAll(async () => {
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  describe('supplier ledger', () => {
    it('raises the balance on receipt and lowers it on payment', async () => {
      const med = await seedMedicine(alpha.tenant, { units_per_pack: 1 });

      await alpha.owner.client.rpc('receive_purchase', {
        p_payload: {
          supplier_id: supplierId,
          paid: 0,
          items: [
            {
              medicine_id: med,
              batch_no: 'LEDGER-1',
              expiry_date: '2028-01-01',
              qty: 100,
              unit_cost: 5,
              selling_price: 9,
            },
          ],
        },
      });

      const { data: owed } = await admin
        .from('suppliers')
        .select('balance')
        .eq('id', supplierId)
        .single();
      expect(Number(owed!.balance)).toBe(500);

      const { data: result, error } = await alpha.owner.client.rpc(
        'pay_supplier',
        { p_supplier_id: supplierId, p_amount: 200, p_method: 'bank' },
      );

      expect(error, error?.message).toBeNull();
      expect(Number(result.balance)).toBe(300);

      const { data: after } = await admin
        .from('suppliers')
        .select('balance')
        .eq('id', supplierId)
        .single();
      expect(Number(after!.balance)).toBe(300);
    });

    it('records the payment alongside the balance movement', async () => {
      const { data } = await admin
        .from('supplier_payments')
        .select('amount, method')
        .eq('supplier_id', supplierId);

      expect(data).toHaveLength(1);
      expect(Number(data![0].amount)).toBe(200);
      expect(data![0].method).toBe('bank');
    });

    it('rejects a zero or negative payment', async () => {
      for (const amount of [0, -50]) {
        const { error } = await alpha.owner.client.rpc('pay_supplier', {
          p_supplier_id: supplierId,
          p_amount: amount,
        });
        expect(error, `amount ${amount} should be rejected`).not.toBeNull();
      }
    });

    it('refuses payment by a cashier', async () => {
      const { error } = await alpha.cashier.client.rpc('pay_supplier', {
        p_supplier_id: supplierId,
        p_amount: 10,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/role \(cashier\) may not/i);
    });

    it("refuses payment against another pharmacy's supplier", async () => {
      const { error } = await beta.owner.client.rpc('pay_supplier', {
        p_supplier_id: supplierId,
        p_amount: 10,
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/unknown supplier/i);

      const { data: after } = await admin
        .from('suppliers')
        .select('balance')
        .eq('id', supplierId)
        .single();
      expect(Number(after!.balance)).toBe(300);
    });

    it('cannot be written to directly, even by an owner', async () => {
      // No insert policy exists: a payment that did not move the balance would
      // make the ledger lie.
      const { error } = await alpha.owner.client
        .from('supplier_payments')
        .insert({
          tenant_id: alpha.tenant.id,
          supplier_id: supplierId,
          amount: 999,
        });
      expect(error).not.toBeNull();
    });

    it("does not show another pharmacy's payments", async () => {
      const { data } = await beta.owner.client
        .from('supplier_payments')
        .select('amount');
      expect(data ?? []).toEqual([]);
    });
  });

  describe('reorder report', () => {
    it('lists only items below their minimum, with a top-up quantity', async () => {
      const low = await seedMedicine(alpha.tenant, {
        name: 'Low Item',
        units_per_pack: 10,
        min_stock: 100,
        max_stock: 250,
      });
      const fine = await seedMedicine(alpha.tenant, {
        name: 'Fine Item',
        min_stock: 5,
      });

      await admin.from('batches').insert([
        {
          tenant_id: alpha.tenant.id,
          medicine_id: low,
          batch_no: 'LOW-1',
          expiry_date: '2028-01-01',
          qty_available: 30,
          selling_price: 4,
        },
        {
          tenant_id: alpha.tenant.id,
          medicine_id: fine,
          batch_no: 'FINE-1',
          expiry_date: '2028-01-01',
          qty_available: 500,
          selling_price: 4,
        },
      ]);

      const { data } = await alpha.owner.client
        .from('reorder_report')
        .select('medicine_id, name, suggested_qty, saleable_on_hand');

      const names = (data ?? []).map((r) => r.name);
      expect(names).toContain('Low Item');
      expect(names).not.toContain('Fine Item');

      const row = (data ?? []).find((r) => r.name === 'Low Item')!;
      // Tops up to max (250), not merely to the minimum — ordering the bare
      // shortfall would put the item straight back on this list.
      expect(Number(row.suggested_qty)).toBe(220);
    });

    it('excludes expired stock from the on-hand figure', async () => {
      const med = await seedMedicine(alpha.tenant, {
        name: 'Expired Only',
        min_stock: 50,
      });
      await admin.from('batches').insert({
        tenant_id: alpha.tenant.id,
        medicine_id: med,
        batch_no: 'EXP-1',
        expiry_date: '2020-01-01',
        qty_available: 900,
        selling_price: 4,
      });

      const { data } = await alpha.owner.client
        .from('reorder_report')
        .select('name, saleable_on_hand')
        .eq('medicine_id', med)
        .single();

      // 900 units on the shelf, none of them sellable.
      expect(Number(data!.saleable_on_hand)).toBe(0);
    });

    it("does not leak another pharmacy's items", async () => {
      const { data } = await beta.owner.client
        .from('reorder_report')
        .select('name');
      const names = (data ?? []).map((r) => r.name);
      expect(names).not.toContain('Low Item');
    });

    it('hides last-cost from a cashier', async () => {
      const { data } = await alpha.cashier.client
        .from('reorder_report')
        .select('name, last_unit_cost');

      // The view is security_invoker, so the purchase_items lookup behind
      // `last_unit_cost` runs under the cashier's own RLS and yields nothing.
      for (const row of data ?? []) {
        expect(row.last_unit_cost).toBeNull();
      }
    });
  });
});
