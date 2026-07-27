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
 * Reporting.
 *
 * The point of interest is profit. Cost was deliberately kept out of
 * `sale_items` and left only in `batch_costs`, so margin can only be reached by
 * joining through a table cashiers cannot read. These tests check that the gate
 * really is structural rather than a filter someone could drop.
 */
describe('reports', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;

  beforeAll(async () => {
    alpha = await seedPharmacy('rep-a');
    beta = await seedPharmacy('rep-b');

    const med = await seedMedicine(alpha.tenant, {
      name: 'Report Tablet',
      unit: 'tablet',
      tax_rate: 0,
    });
    await seedBatch(alpha.tenant, med, {
      qty: 200,
      daysToExpiry: 300,
      sellingPrice: 10,
      costPrice: 6,
      batchNo: 'REP-1',
    });

    // Two sales: one kept whole, one partly returned.
    await alpha.cashier.client.rpc('complete_sale', {
      p_payload: {
        payment_method: 'cash',
        paid: 100,
        items: [{ medicine_id: med, qty: 10 }],
      },
    });

    const { data: second } = await alpha.cashier.client.rpc('complete_sale', {
      p_payload: {
        payment_method: 'cash',
        paid: 50,
        items: [{ medicine_id: med, qty: 5 }],
      },
    });

    const { data: lines } = await admin
      .from('sale_items')
      .select('id')
      .eq('sale_id', second.sale_id);

    await alpha.owner.client.rpc('sales_return', {
      p_sale_id: second.sale_id,
      p_items: [{ sale_item_id: lines![0].id, qty: 5 }],
    });

    // Something in the other pharmacy, to prove nothing bleeds across.
    const betaMed = await seedMedicine(beta.tenant, { name: 'Beta Tablet' });
    await seedBatch(beta.tenant, betaMed, {
      qty: 100,
      daysToExpiry: 300,
      sellingPrice: 99,
      costPrice: 1,
    });
  }, 180_000);

  afterAll(async () => {
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  describe('sale_profit', () => {
    it('computes margin from the batch the sale drew on', async () => {
      const { data } = await alpha.owner.client
        .from('sale_profit')
        .select('qty_net, revenue, cost, profit');

      const totals = (data ?? []).reduce(
        (acc, r) => ({
          revenue: acc.revenue + Number(r.revenue),
          cost: acc.cost + Number(r.cost),
          profit: acc.profit + Number(r.profit),
        }),
        { revenue: 0, cost: 0, profit: 0 },
      );

      // 10 kept at 10 = 100 revenue, 10 at cost 6 = 60 cost, 40 profit.
      // The returned five contribute nothing to either side.
      expect(totals.revenue).toBe(100);
      expect(totals.cost).toBe(60);
      expect(totals.profit).toBe(40);
    });

    it('nets returns out rather than counting them as sold', async () => {
      const { data } = await alpha.owner.client
        .from('sale_profit')
        .select('qty_net');

      const sold = (data ?? []).reduce((s, r) => s + Number(r.qty_net), 0);
      expect(sold).toBe(10);
    });

    it('returns absolutely nothing to a cashier', async () => {
      const { data } = await alpha.cashier.client
        .from('sale_profit')
        .select('revenue, cost, profit');

      // An INNER join to batch_costs, which the cashier cannot read. A LEFT
      // join would have leaked revenue with a null margin instead.
      expect(data ?? []).toEqual([]);
    });

    it('is readable by a pharmacist, who may see cost', async () => {
      const { data } = await alpha.pharmacist.client
        .from('sale_profit')
        .select('revenue');
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("never shows another pharmacy's margins", async () => {
      const { data } = await beta.owner.client
        .from('sale_profit')
        .select('medicine_name');
      const names = (data ?? []).map((r) => r.medicine_name);
      expect(names).not.toContain('Report Tablet');
    });
  });

  describe('sales_daily', () => {
    it('summarises the day and splits credit from cash', async () => {
      const { data } = await alpha.owner.client
        .from('sales_daily')
        .select('sale_count, total, cash_total, credit_total');

      const row = data![0];
      expect(Number(row.sale_count)).toBe(2);
      expect(Number(row.total)).toBe(150);
      expect(Number(row.cash_total)).toBe(150);
      expect(Number(row.credit_total ?? 0)).toBe(0);
    });

    it('is visible to a cashier, since it carries no cost', async () => {
      const { data } = await alpha.cashier.client
        .from('sales_daily')
        .select('total');
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("does not include another pharmacy's takings", async () => {
      const { data } = await beta.owner.client
        .from('sales_daily')
        .select('total');
      expect(data ?? []).toEqual([]);
    });
  });

  describe('stock_valuation', () => {
    it('values remaining stock at cost and at retail', async () => {
      const { data } = await alpha.owner.client
        .from('stock_valuation')
        .select('qty_on_hand, cost_value, retail_value')
        .single();

      // 200 in, 10 sold, 5 sold and returned → 190 left.
      expect(Number(data!.qty_on_hand)).toBe(190);
      expect(Number(data!.cost_value)).toBe(1140);
      expect(Number(data!.retail_value)).toBe(1900);
    });

    it('is empty for a cashier', async () => {
      const { data } = await alpha.cashier.client
        .from('stock_valuation')
        .select('cost_value');
      expect(data ?? []).toEqual([]);
    });
  });

  describe('medicine_movement', () => {
    it('reports quantity sold and days of cover', async () => {
      const { data } = await alpha.owner.client
        .from('medicine_movement')
        .select('name, qty_sold_90d, qty_on_hand, days_of_cover')
        .eq('name', 'Report Tablet')
        .single();

      expect(Number(data!.qty_sold_90d)).toBe(10);
      expect(Number(data!.qty_on_hand)).toBe(190);
      expect(Number(data!.days_of_cover)).toBeGreaterThan(0);
    });

    it('carries no cost, so a cashier may read it', async () => {
      const { data } = await alpha.cashier.client
        .from('medicine_movement')
        .select('name');
      expect((data ?? []).length).toBeGreaterThan(0);
    });
  });

  describe('controlled_register', () => {
    it('records a controlled dispensing with prescriber details', async () => {
      const med = await seedMedicine(alpha.tenant, {
        name: 'Controlled Tablet',
        is_controlled: true,
        is_prescription_required: true,
        tax_rate: 0,
      });
      await seedBatch(alpha.tenant, med, {
        qty: 50,
        daysToExpiry: 300,
        sellingPrice: 20,
      });

      const { data: customer } = await admin
        .from('customers')
        .insert({ tenant_id: alpha.tenant.id, name: 'Reg Customer' })
        .select('id')
        .single();

      const { data: rx } = await admin
        .from('prescriptions')
        .insert({
          tenant_id: alpha.tenant.id,
          customer_id: customer!.id,
          prescriber_name: 'Dr Sharma',
          prescriber_reg_no: 'NMC-1234',
          refills_allowed: 1,
        })
        .select('id')
        .single();

      await alpha.cashier.client.rpc('complete_sale', {
        p_payload: {
          customer_id: customer!.id,
          prescription_id: rx!.id,
          payment_method: 'cash',
          paid: 40,
          items: [{ medicine_id: med, qty: 2 }],
        },
      });

      const { data } = await alpha.owner.client
        .from('controlled_register')
        .select(
          'medicine_name, qty, customer_name, prescriber_name, prescriber_reg_no, invoice_no',
        );

      expect(data).toHaveLength(1);
      expect(data![0].medicine_name).toBe('Controlled Tablet');
      expect(Number(data![0].qty)).toBe(2);
      expect(data![0].customer_name).toBe('Reg Customer');
      expect(data![0].prescriber_name).toBe('Dr Sharma');
      expect(data![0].prescriber_reg_no).toBe('NMC-1234');
      // The register has to tie back to the sale for an inspection.
      expect(data![0].invoice_no).toMatch(/^INV-/);
    });

    it('is not readable by a cashier', async () => {
      const { data } = await alpha.cashier.client
        .from('controlled_register')
        .select('medicine_name');
      expect(data ?? []).toEqual([]);
    });
  });
});
