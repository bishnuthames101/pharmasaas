import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { PrintControls } from './print-controls';

export const metadata = { title: 'Receipt' };

interface ReceiptItem {
  name: string;
  strength: string | null;
  unit: string;
  batch_no: string;
  expiry_date: string;
  qty: number;
  unit_price: number;
  discount: number;
  tax: number;
  total: number;
}

interface Receipt {
  sale: {
    invoice_no: string;
    sale_date: string;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    paid: number;
    payment_method: string | null;
    status: string;
  };
  customer: { name: string; phone: string | null } | null;
  settings: {
    pharmacy_name: string | null;
    address: string | null;
    phone: string | null;
    currency: string;
    tax_mode: string;
  } | null;
  items: ReceiptItem[];
}

export default async function ReceiptPage(
  props: PageProps<'/t/[tenant]/pos/receipt/[saleId]'>,
) {
  const { tenant: slug, saleId } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();
  // security_invoker, so RLS decides whether this sale is visible at all.
  const { data } = await supabase.rpc('sale_receipt', { p_sale_id: saleId });

  const receipt = data as Receipt | null;
  if (!receipt?.sale) notFound();

  const { sale, settings, customer, items } = receipt;
  const currency = settings?.currency ?? 'NPR';

  return (
    <>
      <PrintControls />

      {/*
        One markup, two paper sizes. Width is set by a print stylesheet keyed on
        `data-print`, so switching between an 80mm roll and A4 does not re-render
        or re-fetch anything.
      */}
      <article
        id="receipt"
        data-print="thermal"
        className="mx-auto w-full max-w-[80mm] px-4 py-6 font-mono text-xs"
      >
        <header className="text-center">
          <h1 className="text-sm font-bold">
            {settings?.pharmacy_name ?? 'Pharmacy'}
          </h1>
          {settings?.address && <p>{settings.address}</p>}
          {settings?.phone && <p>{settings.phone}</p>}
        </header>

        <div className="my-2 border-t border-dashed" />

        <div className="flex justify-between">
          <span>Invoice</span>
          <span className="font-bold">{sale.invoice_no}</span>
        </div>
        <div className="flex justify-between">
          <span>Date</span>
          <span>{new Date(sale.sale_date).toLocaleString()}</span>
        </div>
        {customer && (
          <div className="flex justify-between">
            <span>Customer</span>
            <span>{customer.name}</span>
          </div>
        )}

        <div className="my-2 border-t border-dashed" />

        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th>Item</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Amt</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i} className="align-top">
                <td>
                  {item.name}
                  {item.strength ? ` ${item.strength}` : ''}
                  {/* Batch and expiry belong on a dispensing receipt: it is
                      what a customer needs if a recall is issued. */}
                  <span className="block opacity-70">
                    {item.batch_no} · exp {item.expiry_date}
                  </span>
                </td>
                <td className="text-right">{Number(item.qty)}</td>
                <td className="text-right">
                  {Number(item.unit_price).toFixed(2)}
                </td>
                <td className="text-right">{Number(item.total).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="my-2 border-t border-dashed" />

        <Line label="Subtotal" value={sale.subtotal} currency={currency} />
        {Number(sale.discount) > 0 && (
          <Line label="Discount" value={-sale.discount} currency={currency} />
        )}
        <Line
          label={settings?.tax_mode === 'inclusive' ? 'Tax (incl.)' : 'Tax'}
          value={sale.tax}
          currency={currency}
        />
        <div className="flex justify-between text-sm font-bold">
          <span>Total</span>
          <span>
            {currency} {Number(sale.total).toFixed(2)}
          </span>
        </div>
        <Line label="Paid" value={sale.paid} currency={currency} />
        <Line
          label="Change"
          value={Number(sale.paid) - Number(sale.total)}
          currency={currency}
        />

        <div className="my-2 border-t border-dashed" />

        <p className="text-center">
          {sale.payment_method ?? 'cash'}
          {sale.status !== 'completed' && ` · ${sale.status}`}
        </p>
        <p className="mt-2 text-center opacity-70">
          Medicines are not returnable once dispensed, except as required by
          law.
        </p>
      </article>
    </>
  );
}

function Line({
  label,
  value,
  currency,
}: {
  label: string;
  value: number;
  currency: string;
}) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>
        {currency} {Number(value).toFixed(2)}
      </span>
    </div>
  );
}
