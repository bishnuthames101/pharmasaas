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
 * The counter: search, the full sale cycle, and the receipt.
 */
describe('point of sale', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;
  let paracetamol: string;

  beforeAll(async () => {
    alpha = await seedPharmacy('pos-a');
    beta = await seedPharmacy('pos-b');

    paracetamol = await seedMedicine(alpha.tenant, {
      name: 'Paracetamol 500mg',
      generic_name: 'paracetamol',
      barcode: '8901234567890',
      unit: 'tablet',
      tax_rate: 0,
    });
    await seedBatch(alpha.tenant, paracetamol, {
      qty: 100,
      daysToExpiry: 200,
      sellingPrice: 3,
      batchNo: 'POS-A',
    });

    const betaMed = await seedMedicine(beta.tenant, {
      name: 'Beta Secret Syrup',
      barcode: '8901234567890', // same barcode, different pharmacy
    });
    await seedBatch(beta.tenant, betaMed, { qty: 50, daysToExpiry: 200 });
  }, 120_000);

  afterAll(async () => {
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  describe('pos_search', () => {
    it('finds by brand, generic and barcode', async () => {
      for (const q of ['Paracetamol', 'paracetamol', '8901234567890']) {
        const { data } = await alpha.cashier.client.rpc('pos_search', {
          p_query: q,
        });
        expect(
          (data ?? []).map((r: { name: string }) => r.name),
          `query "${q}"`,
        ).toContain('Paracetamol 500mg');
      }
    });

    it('flags an exact barcode so a scan can be auto-added', async () => {
      const { data } = await alpha.cashier.client.rpc('pos_search', {
        p_query: '8901234567890',
      });
      expect(data![0].exact_barcode).toBe(true);
    });

    it('returns the FEFO batch and saleable quantity', async () => {
      const { data } = await alpha.cashier.client.rpc('pos_search', {
        p_query: 'Paracetamol',
      });
      const row = data![0];
      expect(row.batch_no).toBe('POS-A');
      expect(Number(row.saleable_on_hand)).toBe(100);
      expect(Number(row.selling_price)).toBe(3);
    });

    it('never crosses pharmacies, even on an identical barcode', async () => {
      const { data } = await alpha.cashier.client.rpc('pos_search', {
        p_query: '8901234567890',
      });
      const names = (data ?? []).map((r: { name: string }) => r.name);

      // Two pharmacies genuinely can stock the same barcode; the search must
      // still only ever answer with the caller's own.
      expect(names).toContain('Paracetamol 500mg');
      expect(names).not.toContain('Beta Secret Syrup');
    });

    it('shows an out-of-stock item with a null batch rather than hiding it', async () => {
      const empty = await seedMedicine(alpha.tenant, { name: 'Empty Item' });
      const { data } = await alpha.cashier.client.rpc('pos_search', {
        p_query: 'Empty Item',
      });

      // Hiding it would leave the cashier wondering whether they mistyped.
      const row = (data ?? []).find(
        (r: { medicine_id: string }) => r.medicine_id === empty,
      );
      expect(row).toBeTruthy();
      expect(row.batch_id).toBeNull();
      expect(Number(row.saleable_on_hand)).toBe(0);
    });
  });

  describe('full sale cycle', () => {
    let saleId: string;
    let invoiceNo: string;

    it('completes a sale from the counter', async () => {
      const { data, error } = await alpha.cashier.client.rpc('complete_sale', {
        p_payload: {
          payment_method: 'cash',
          paid: 30,
          items: [{ medicine_id: paracetamol, qty: 10 }],
        },
      });

      expect(error, error?.message).toBeNull();
      saleId = data.sale_id;
      invoiceNo = data.invoice_no;
      expect(Number(data.total)).toBe(30);
    });

    it('builds a receipt with batch and expiry on every line', async () => {
      const { data, error } = await alpha.cashier.client.rpc('sale_receipt', {
        p_sale_id: saleId,
      });

      expect(error, error?.message).toBeNull();
      expect(data.sale.invoice_no).toBe(invoiceNo);
      expect(data.settings.currency).toBe('NPR');
      expect(data.items).toHaveLength(1);

      // Batch and expiry on the receipt are what a customer needs if the batch
      // is later recalled.
      expect(data.items[0].batch_no).toBe('POS-A');
      expect(data.items[0].expiry_date).toBeTruthy();
      expect(Number(data.items[0].qty)).toBe(10);
    });

    it("refuses to build a receipt for another pharmacy's sale", async () => {
      const { data } = await beta.owner.client.rpc('sale_receipt', {
        p_sale_id: saleId,
      });
      expect(data).toBeNull();
    });

    it('returns part of the sale and restocks the same batch', async () => {
      const { data: lines } = await admin
        .from('sale_items')
        .select('id, batch_id')
        .eq('sale_id', saleId);

      const { data: before } = await admin
        .from('batches')
        .select('qty_available')
        .eq('id', lines![0].batch_id)
        .single();

      const { data: result, error } = await alpha.owner.client.rpc(
        'sales_return',
        {
          p_sale_id: saleId,
          p_items: [{ sale_item_id: lines![0].id, qty: 4 }],
        },
      );

      expect(error, error?.message).toBeNull();
      expect(Number(result.refund)).toBe(12);

      const { data: after } = await admin
        .from('batches')
        .select('qty_available')
        .eq('id', lines![0].batch_id)
        .single();

      expect(Number(after!.qty_available)).toBe(
        Number(before!.qty_available) + 4,
      );
    });

    it('marks the sale partially returned', async () => {
      const { data } = await admin
        .from('sales')
        .select('status')
        .eq('id', saleId)
        .single();
      expect(data!.status).toBe('partially_returned');
    });

    it('marks it fully returned once the rest comes back', async () => {
      const { data: lines } = await admin
        .from('sale_items')
        .select('id')
        .eq('sale_id', saleId);

      await alpha.owner.client.rpc('sales_return', {
        p_sale_id: saleId,
        p_items: [{ sale_item_id: lines![0].id, qty: 6 }],
      });

      const { data } = await admin
        .from('sales')
        .select('status')
        .eq('id', saleId)
        .single();
      expect(data!.status).toBe('returned');
    });
  });

  describe('credit sales', () => {
    it("adds the unpaid balance to the customer's account", async () => {
      const { data: customer } = await admin
        .from('customers')
        .insert({ tenant_id: alpha.tenant.id, name: 'Credit Customer' })
        .select('id')
        .single();

      await alpha.cashier.client.rpc('complete_sale', {
        p_payload: {
          customer_id: customer!.id,
          payment_method: 'credit',
          paid: 0,
          items: [{ medicine_id: paracetamol, qty: 5 }],
        },
      });

      const { data: after } = await admin
        .from('customers')
        .select('credit_balance')
        .eq('id', customer!.id)
        .single();

      expect(Number(after!.credit_balance)).toBe(15);
    });
  });

  describe('cashier reach', () => {
    it('can see sales but cannot process a return', async () => {
      const { data: visible } = await alpha.cashier.client
        .from('sales')
        .select('id');
      expect(visible!.length).toBeGreaterThan(0);

      const { error } = await alpha.cashier.client.rpc('sales_return', {
        p_sale_id: visible![0].id,
        p_items: [],
      });
      expect(error).not.toBeNull();
    });

    it("cannot see another pharmacy's sales", async () => {
      const { data } = await beta.cashier.client.from('sales').select('id');
      expect(data ?? []).toEqual([]);
    });
  });
});
