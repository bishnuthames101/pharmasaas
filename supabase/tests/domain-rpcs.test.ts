import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  admin,
  cleanupPharmacy,
  seedBatch,
  seedMedicine,
  seedPharmacy,
  type SeededPharmacy,
} from './helpers';

/**
 * The business RPCs.
 *
 * These functions are SECURITY DEFINER, so RLS is switched off inside them and
 * the tenant predicates written by hand are the only isolation left. The
 * coverage gate cannot see into a function body, which makes this suite the
 * only thing standing between a missing `and tenant_id = v_tenant` and a
 * cross-tenant write.
 */
describe('domain RPCs', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;

  beforeAll(async () => {
    alpha = await seedPharmacy('alpha');
    beta = await seedPharmacy('beta');
  }, 120_000);

  afterAll(async () => {
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  // -------------------------------------------------------------------------
  describe('batch_costs is genuinely hidden from cashiers', () => {
    it('lets an owner read cost', async () => {
      const med = await seedMedicine(alpha.tenant);
      await seedBatch(alpha.tenant, med, {
        qty: 50,
        daysToExpiry: 200,
        costPrice: 42,
      });

      const { data } = await alpha.owner.client
        .from('batch_costs')
        .select('cost_price');

      expect(data!.length).toBeGreaterThan(0);
      expect(Number(data![0].cost_price)).toBeGreaterThan(0);
    });

    it('returns nothing to a cashier', async () => {
      const { data } = await alpha.cashier.client
        .from('batch_costs')
        .select('cost_price');

      // This is the whole reason cost was split off `batches`: a row filter can
      // express it, a column filter could not.
      expect(data ?? []).toEqual([]);
    });

    it('still lets a cashier read the batch itself, so they can sell', async () => {
      const { data } = await alpha.cashier.client
        .from('batches')
        .select('id, selling_price, expiry_date, qty_available');

      expect(data!.length).toBeGreaterThan(0);
      expect(Object.keys(data![0])).not.toContain('cost_price');
    });

    it('refuses a cashier writing cost', async () => {
      const { error } = await alpha.cashier.client
        .from('batch_costs')
        .insert({ batch_id: randomUUID(), cost_price: 1 });
      expect(error).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('FEFO allocation', () => {
    it('takes the earliest expiry first and spans batches', async () => {
      const med = await seedMedicine(alpha.tenant);
      await seedBatch(alpha.tenant, med, {
        qty: 10,
        daysToExpiry: 200,
        batchNo: 'LATE',
      });
      await seedBatch(alpha.tenant, med, {
        qty: 6,
        daysToExpiry: 30,
        batchNo: 'SOON',
      });

      const { data, error } = await alpha.cashier.client.rpc('fefo_preview', {
        p_medicine_id: med,
        p_qty: 9,
      });

      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      // Earliest expiry exhausted first, remainder from the later batch.
      expect(data![0].batch_no).toBe('SOON');
      expect(Number(data![0].qty_taken)).toBe(6);
      expect(data![1].batch_no).toBe('LATE');
      expect(Number(data![1].qty_taken)).toBe(3);
    });

    it('excludes expired stock entirely', async () => {
      const med = await seedMedicine(alpha.tenant);
      await seedBatch(alpha.tenant, med, {
        qty: 100,
        daysToExpiry: -1,
        batchNo: 'EXPIRED',
      });

      const { data } = await alpha.cashier.client.rpc('fefo_preview', {
        p_medicine_id: med,
        p_qty: 5,
      });

      expect(data ?? []).toEqual([]);
    });

    it('does not see another pharmacy stock', async () => {
      const med = await seedMedicine(beta.tenant);
      await seedBatch(beta.tenant, med, { qty: 100, daysToExpiry: 100 });

      const { data } = await alpha.cashier.client.rpc('fefo_preview', {
        p_medicine_id: med,
        p_qty: 1,
      });

      expect(data ?? []).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('complete_sale', () => {
    it('sells, decrements the exact batch, and returns an invoice number', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      const batch = await seedBatch(alpha.tenant, med, {
        qty: 20,
        daysToExpiry: 90,
        sellingPrice: 50,
      });

      const { data, error } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: {
          payment_method: 'cash',
          paid: 250,
          items: [{ medicine_id: med, qty: 5 }],
        },
      });

      expect(error, error?.message).toBeNull();
      expect(data.invoice_no).toMatch(/^INV-\d+$/);
      expect(Number(data.total)).toBe(250);

      const { data: after } = await admin
        .from('batches')
        .select('qty_available')
        .eq('id', batch)
        .single();
      expect(Number(after!.qty_available)).toBe(15);
    });

    it('numbers invoices consecutively and per pharmacy', async () => {
      const medA = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      await seedBatch(alpha.tenant, medA, { qty: 100, daysToExpiry: 90 });
      const medB = await seedMedicine(beta.tenant, { tax_rate: 0 });
      await seedBatch(beta.tenant, medB, { qty: 100, daysToExpiry: 90 });

      const seqOf = (invoice: string) => Number(invoice.split('-')[1]);

      const first = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: medA, qty: 1 }] },
      });
      const second = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: medA, qty: 1 }] },
      });

      expect(seqOf(second.data.invoice_no)).toBe(
        seqOf(first.data.invoice_no) + 1,
      );

      // Beta's counter is its own; a busy neighbour must not advance it.
      const betaSale = await beta.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: medB, qty: 1 }] },
      });
      expect(seqOf(betaSale.data.invoice_no)).toBe(1);
    });

    it('refuses to sell more than is in stock, and changes nothing', async () => {
      const med = await seedMedicine(alpha.tenant);
      const batch = await seedBatch(alpha.tenant, med, {
        qty: 3,
        daysToExpiry: 90,
      });

      const { error } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 10 }] },
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/insufficient stock/i);

      const { data: after } = await admin
        .from('batches')
        .select('qty_available')
        .eq('id', batch)
        .single();
      expect(Number(after!.qty_available)).toBe(3);
    });

    it('rolls the invoice number back when a sale fails', async () => {
      const { data: before } = await admin
        .from('settings')
        .select('next_invoice_seq')
        .eq('tenant_id', alpha.tenant.id)
        .single();

      const med = await seedMedicine(alpha.tenant);
      await seedBatch(alpha.tenant, med, { qty: 1, daysToExpiry: 90 });

      await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 999 }] },
      });

      const { data: after } = await admin
        .from('settings')
        .select('next_invoice_seq')
        .eq('tenant_id', alpha.tenant.id)
        .single();

      // A burnt number would leave a gap in the invoice book.
      expect(Number(after!.next_invoice_seq)).toBe(
        Number(before!.next_invoice_seq),
      );
    });

    it('takes the price from the batch, not from the payload', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      await seedBatch(alpha.tenant, med, {
        qty: 10,
        daysToExpiry: 90,
        sellingPrice: 80,
      });

      const { data } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: {
          items: [{ medicine_id: med, qty: 2, unit_price: 1, total: 2 }],
        },
      });

      // A cashier who could name the price could sell to a friend for nothing.
      expect(Number(data.total)).toBe(160);
    });

    it('blocks a prescription-only medicine with no prescription attached', async () => {
      const med = await seedMedicine(alpha.tenant, {
        is_prescription_required: true,
      });
      await seedBatch(alpha.tenant, med, { qty: 10, daysToExpiry: 90 });

      const { error } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 1 }] },
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/requires a prescription/i);
    });

    it('writes the controlled register when a controlled item is dispensed', async () => {
      const med = await seedMedicine(alpha.tenant, { is_controlled: true });
      await seedBatch(alpha.tenant, med, { qty: 10, daysToExpiry: 90 });

      const { data: sale } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 2 }] },
      });
      expect(sale).not.toBeNull();

      const { data: log } = await admin
        .from('controlled_dispense_log')
        .select('qty, medicine_id')
        .eq('tenant_id', alpha.tenant.id)
        .eq('medicine_id', med);

      expect(log).toHaveLength(1);
      expect(Number(log![0].qty)).toBe(2);
    });

    it('applies tax exclusively by default', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 13 });
      await seedBatch(alpha.tenant, med, {
        qty: 10,
        daysToExpiry: 90,
        sellingPrice: 100,
      });

      const { data } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 1 }] },
      });

      expect(Number(data.subtotal)).toBe(100);
      expect(Number(data.tax)).toBe(13);
      expect(Number(data.total)).toBe(113);
    });
  });

  // -------------------------------------------------------------------------
  describe('RPC tenant confinement', () => {
    it("refuses to sell another pharmacy's medicine", async () => {
      const betaMed = await seedMedicine(beta.tenant);
      await seedBatch(beta.tenant, betaMed, { qty: 100, daysToExpiry: 90 });

      const { error } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: betaMed, qty: 1 }] },
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/unknown or inactive medicine/i);
    });

    it("refuses to attach a sale to another pharmacy's customer", async () => {
      const { data: betaCustomer } = await admin
        .from('customers')
        .insert({ tenant_id: beta.tenant.id, name: 'Beta Customer' })
        .select('id')
        .single();

      const med = await seedMedicine(alpha.tenant);
      await seedBatch(alpha.tenant, med, { qty: 10, daysToExpiry: 90 });

      const { error } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: {
          customer_id: betaCustomer!.id,
          items: [{ medicine_id: med, qty: 1 }],
        },
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/unknown customer/i);
    });

    it("refuses to adjust another pharmacy's batch", async () => {
      const betaMed = await seedMedicine(beta.tenant);
      const betaBatch = await seedBatch(beta.tenant, betaMed, {
        qty: 50,
        daysToExpiry: 90,
      });

      const { error } = await alpha.owner.client.rpc('adjust_stock', {
        p_batch_id: betaBatch,
        p_qty_change: -50,
        p_reason: 'theft',
      });

      expect(error).not.toBeNull();

      const { data: after } = await admin
        .from('batches')
        .select('qty_available')
        .eq('id', betaBatch)
        .single();
      expect(Number(after!.qty_available)).toBe(50);
    });

    it("refuses to return against another pharmacy's sale", async () => {
      const betaMed = await seedMedicine(beta.tenant);
      await seedBatch(beta.tenant, betaMed, { qty: 10, daysToExpiry: 90 });
      const { data: betaSale } = await beta.cashier.client.rpc(
        'complete_sale',
        { p_payload: { items: [{ medicine_id: betaMed, qty: 1 }] } },
      );

      const { error } = await alpha.owner.client.rpc('sales_return', {
        p_sale_id: betaSale.sale_id,
        p_items: [],
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/unknown sale/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('role gates on RPCs', () => {
    it('refuses goods receipt by a cashier', async () => {
      const { error } = await alpha.cashier.client.rpc('receive_purchase', {
        p_payload: { items: [] },
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/role \(cashier\) may not/i);
    });

    it('refuses stock adjustment by a cashier', async () => {
      const med = await seedMedicine(alpha.tenant);
      const batch = await seedBatch(alpha.tenant, med, {
        qty: 10,
        daysToExpiry: 90,
      });

      const { error } = await alpha.cashier.client.rpc('adjust_stock', {
        p_batch_id: batch,
        p_qty_change: -1,
        p_reason: 'damage',
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/role \(cashier\) may not/i);
    });

    it('lets a pharmacist receive goods', async () => {
      const med = await seedMedicine(alpha.tenant);
      const { error } = await alpha.pharmacist.client.rpc('receive_purchase', {
        p_payload: {
          items: [
            {
              medicine_id: med,
              batch_no: 'PH-1',
              expiry_date: '2028-01-01',
              qty: 5,
              pack_mode: true,
              unit_cost: 10,
              selling_price: 20,
            },
          ],
        },
      });
      expect(error, error?.message).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('receive_purchase', () => {
    it('converts packs to smallest units exactly once', async () => {
      const med = await seedMedicine(alpha.tenant, { units_per_pack: 10 });

      await alpha.owner.client.rpc('receive_purchase', {
        p_payload: {
          items: [
            {
              medicine_id: med,
              batch_no: 'PACK-1',
              expiry_date: '2028-06-01',
              qty: 3,
              pack_mode: true,
              unit_cost: 5,
              selling_price: 9,
            },
          ],
        },
      });

      const { data } = await admin
        .from('batches')
        .select('qty_available')
        .eq('tenant_id', alpha.tenant.id)
        .eq('batch_no', 'PACK-1')
        .single();

      expect(Number(data!.qty_available)).toBe(30);
    });

    it('tops up an existing batch rather than duplicating it', async () => {
      const med = await seedMedicine(alpha.tenant, { units_per_pack: 1 });
      const line = {
        medicine_id: med,
        batch_no: 'TOPUP',
        expiry_date: '2028-06-01',
        qty: 10,
        unit_cost: 4,
        selling_price: 8,
      };

      await alpha.owner.client.rpc('receive_purchase', {
        p_payload: { items: [line] },
      });
      await alpha.owner.client.rpc('receive_purchase', {
        p_payload: { items: [line] },
      });

      const { data } = await admin
        .from('batches')
        .select('qty_available')
        .eq('tenant_id', alpha.tenant.id)
        .eq('batch_no', 'TOPUP');

      expect(data).toHaveLength(1);
      expect(Number(data![0].qty_available)).toBe(20);
    });

    it('records cost and moves the supplier balance', async () => {
      const med = await seedMedicine(alpha.tenant, { units_per_pack: 1 });
      const { data: supplier } = await admin
        .from('suppliers')
        .insert({ tenant_id: alpha.tenant.id, name: 'Acme Distributors' })
        .select('id')
        .single();

      await alpha.owner.client.rpc('receive_purchase', {
        p_payload: {
          supplier_id: supplier!.id,
          paid: 20,
          items: [
            {
              medicine_id: med,
              batch_no: 'COST-1',
              expiry_date: '2028-06-01',
              qty: 10,
              unit_cost: 7,
              selling_price: 12,
            },
          ],
        },
      });

      const { data: batch } = await admin
        .from('batches')
        .select('id')
        .eq('tenant_id', alpha.tenant.id)
        .eq('batch_no', 'COST-1')
        .single();

      const { data: cost } = await admin
        .from('batch_costs')
        .select('cost_price')
        .eq('batch_id', batch!.id)
        .single();
      expect(Number(cost!.cost_price)).toBe(7);

      const { data: after } = await admin
        .from('suppliers')
        .select('balance')
        .eq('id', supplier!.id)
        .single();
      // 10 units x 7 = 70 received, 20 paid, so 50 outstanding.
      expect(Number(after!.balance)).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  describe('sales_return', () => {
    it('restocks the originating batch', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      const batch = await seedBatch(alpha.tenant, med, {
        qty: 10,
        daysToExpiry: 90,
        sellingPrice: 30,
      });

      const { data: sale } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 4 }] },
      });

      const { data: lines } = await admin
        .from('sale_items')
        .select('id, batch_id')
        .eq('sale_id', sale.sale_id);

      const { data: result, error } = await alpha.owner.client.rpc(
        'sales_return',
        {
          p_sale_id: sale.sale_id,
          p_items: [{ sale_item_id: lines![0].id, qty: 3 }],
        },
      );

      expect(error, error?.message).toBeNull();
      expect(Number(result.refund)).toBe(90);

      const { data: after } = await admin
        .from('batches')
        .select('qty_available')
        .eq('id', batch)
        .single();
      // 10 sold down to 6, three returned to the same batch.
      expect(Number(after!.qty_available)).toBe(9);
    });

    it('refuses to return more than was sold', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      await seedBatch(alpha.tenant, med, { qty: 10, daysToExpiry: 90 });

      const { data: sale } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 2 }] },
      });
      const { data: lines } = await admin
        .from('sale_items')
        .select('id')
        .eq('sale_id', sale.sale_id);

      const { error } = await alpha.owner.client.rpc('sales_return', {
        p_sale_id: sale.sale_id,
        p_items: [{ sale_item_id: lines![0].id, qty: 5 }],
      });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/more than was sold/i);
    });

    it('refuses returns by a cashier', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      await seedBatch(alpha.tenant, med, { qty: 10, daysToExpiry: 90 });
      const { data: sale } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: { items: [{ medicine_id: med, qty: 1 }] },
      });

      const { error } = await alpha.cashier.client.rpc('sales_return', {
        p_sale_id: sale.sale_id,
        p_items: [],
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/role \(cashier\) may not/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('sales tables are write-only through the RPC', () => {
    it('refuses a direct sale insert even by an owner', async () => {
      const { error } = await alpha.owner.client.from('sales').insert({
        tenant_id: alpha.tenant.id,
        invoice_no: 'FORGED-1',
      });

      // No insert policy exists, so nothing can bypass invoice numbering,
      // FEFO, or the controlled register.
      expect(error).not.toBeNull();
    });

    it('refuses a direct stock edit by a cashier', async () => {
      const med = await seedMedicine(alpha.tenant);
      const batch = await seedBatch(alpha.tenant, med, {
        qty: 5,
        daysToExpiry: 90,
      });

      await alpha.cashier.client
        .from('batches')
        .update({ qty_available: 9999, selling_price: 1 })
        .eq('id', batch);

      const { data: after } = await admin
        .from('batches')
        .select('qty_available, selling_price')
        .eq('id', batch)
        .single();

      expect(Number(after!.qty_available)).toBe(5);
      expect(Number(after!.selling_price)).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  describe('adjust_stock', () => {
    it('records a reason and cannot drive stock negative', async () => {
      const med = await seedMedicine(alpha.tenant);
      const batch = await seedBatch(alpha.tenant, med, {
        qty: 5,
        daysToExpiry: 90,
      });

      const { error: tooMuch } = await alpha.owner.client.rpc('adjust_stock', {
        p_batch_id: batch,
        p_qty_change: -6,
        p_reason: 'damage',
      });
      expect(tooMuch).not.toBeNull();

      const { error } = await alpha.owner.client.rpc('adjust_stock', {
        p_batch_id: batch,
        p_qty_change: -2,
        p_reason: 'damage',
        p_notes: 'Crushed in transit',
      });
      expect(error, error?.message).toBeNull();

      const { data: adjustments } = await admin
        .from('stock_adjustments')
        .select('qty_change, reason')
        .eq('batch_id', batch);

      expect(adjustments).toHaveLength(1);
      expect(Number(adjustments![0].qty_change)).toBe(-2);
      expect(adjustments![0].reason).toBe('damage');
    });
  });

  // -------------------------------------------------------------------------
  describe('concurrency', () => {
    it('does not oversell one batch to two simultaneous tills', async () => {
      const med = await seedMedicine(alpha.tenant, { tax_rate: 0 });
      const batch = await seedBatch(alpha.tenant, med, {
        qty: 10,
        daysToExpiry: 90,
      });

      // Two tills, each trying to take 7 of the 10 available. Exactly one must
      // succeed; without FOR UPDATE the pair would both read 10 and both sell.
      const results = await Promise.all([
        alpha.cashier.client.rpc('complete_sale', {
          p_payload: { items: [{ medicine_id: med, qty: 7 }] },
        }),
        alpha.pharmacist.client.rpc('complete_sale', {
          p_payload: { items: [{ medicine_id: med, qty: 7 }] },
        }),
      ]);

      const succeeded = results.filter((r) => r.error === null).length;
      expect(succeeded).toBe(1);

      const { data: after } = await admin
        .from('batches')
        .select('qty_available')
        .eq('id', batch)
        .single();
      expect(Number(after!.qty_available)).toBe(3);
    });
  });
});
