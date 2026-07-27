'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  checkout,
  quickCreateCustomer,
  searchCustomers,
  searchForSale,
  type PosResult,
} from '@/lib/pos/actions';
import { cn } from '@/lib/utils';

interface CartLine {
  medicineId: string;
  name: string;
  unit: string;
  batchNo: string | null;
  expiryDate: string | null;
  unitPrice: number;
  qty: number;
  discount: number;
  isControlled: boolean;
  isRxRequired: boolean;
  available: number;
}

interface CustomerOption {
  id: string;
  name: string;
  phone: string | null;
  creditBalance: number;
}

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'credit', label: 'Credit' },
] as const;

/**
 * The counter.
 *
 * Built keyboard-first because a pharmacy queue does not wait for a mouse:
 * focus starts in the search box and returns there after every add, arrow keys
 * move the result list, Enter adds, and F2/F4 jump to payment and completion.
 *
 * Totals shown here are an estimate for the customer's benefit. The invoice is
 * calculated by `complete_sale` from batch prices, so what is charged never
 * depends on what this component computed.
 */
export function PosTerminal({
  slug,
  taxRate,
  taxMode,
  currency,
  canSeeReturns,
}: {
  slug: string;
  taxRate: number;
  taxMode: string;
  currency: string;
  canSeeReturns: boolean;
}) {
  const [query, setQuery] = useState('');
  // Results are stored with the query they belong to, so what is displayed can
  // be derived rather than cleared. That keeps the effect free of synchronous
  // setState, and makes a slow response for an abandoned query harmless: it no
  // longer matches, so it is simply never shown.
  const [fetched, setFetched] = useState<{
    query: string;
    rows: PosResult[];
  } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerOption[]>([]);
  const [showCustomer, setShowCustomer] = useState(false);
  const [method, setMethod] = useState<string>('cash');
  const [paid, setPaid] = useState('');
  const [prescriptionId, setPrescriptionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    invoiceNo: string;
    total: number;
    saleId: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const searchRef = useRef<HTMLInputElement>(null);
  const paidRef = useRef<HTMLInputElement>(null);

  // Stable identity: the search effect depends on it, and a new function each
  // render would restart the debounce on every keystroke's re-render.
  const addToCart = useCallback((row: PosResult) => {
    setError(null);

    if (!row.batch_id || row.saleable_on_hand <= 0) {
      setError(`${row.name} is out of stock.`);
      return;
    }

    setCart((prev) => {
      const existing = prev.find((l) => l.medicineId === row.medicine_id);
      if (existing) {
        // Scanning the same item again is the normal way to increase quantity,
        // and it must not exceed what is actually on the shelf.
        return prev.map((l) =>
          l.medicineId === row.medicine_id
            ? { ...l, qty: Math.min(l.qty + 1, l.available) }
            : l,
        );
      }
      return [
        ...prev,
        {
          medicineId: row.medicine_id,
          name: row.name,
          unit: row.unit,
          batchNo: row.batch_no,
          expiryDate: row.expiry_date,
          unitPrice: row.selling_price ?? 0,
          qty: 1,
          discount: 0,
          isControlled: row.is_controlled,
          isRxRequired: row.is_prescription_required,
          available: row.saleable_on_hand,
        },
      ];
    });

    searchRef.current?.focus();
  }, []);

  // Debounced so a barcode wedge (which types fast then sends Enter) does not
  // fire a request per character.
  useEffect(() => {
    if (!query.trim()) return;

    const timer = setTimeout(async () => {
      const rows = await searchForSale(slug, query);
      setFetched({ query, rows });
      setHighlight(0);
      // A barcode scan is unambiguous, so add it and clear for the next scan.
      if (rows.length === 1 && rows[0].exact_barcode) {
        addToCart(rows[0]);
        setQuery('');
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [query, slug, addToCart]);

  const results = query.trim() && fetched?.query === query ? fetched.rows : [];

  useEffect(() => {
    if (!showCustomer) return;
    const timer = setTimeout(async () => {
      setCustomerResults(await searchCustomers(slug, customerQuery));
    }, 200);
    return () => clearTimeout(timer);
  }, [customerQuery, showCustomer, slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        paidRef.current?.focus();
      }
      if (e.key === 'F4') {
        e.preventDefault();
        void complete();
      }
      if (e.key === 'Escape') {
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const totals = useMemo(() => {
    let subtotal = 0;
    let discount = 0;
    let tax = 0;
    for (const line of cart) {
      const gross = line.qty * line.unitPrice;
      const net = gross - line.discount;
      const lineTax =
        taxMode === 'inclusive'
          ? net - net / (1 + taxRate / 100)
          : (net * taxRate) / 100;
      subtotal += gross;
      discount += line.discount;
      tax += lineTax;
    }
    const total =
      taxMode === 'inclusive' ? subtotal - discount : subtotal - discount + tax;
    return { subtotal, discount, tax, total };
  }, [cart, taxRate, taxMode]);

  const needsRx = cart.some((l) => l.isRxRequired);
  const change = Number(paid || 0) - totals.total;

  async function complete() {
    if (cart.length === 0 || pending) return;
    setError(null);

    startTransition(async () => {
      const result = await checkout({
        slug,
        customerId: customer?.id ?? null,
        prescriptionId: prescriptionId.trim() || null,
        paymentMethod: method as 'cash' | 'card' | 'wallet' | 'credit',
        paid: Number(paid || 0),
        lines: cart.map((l) => ({
          medicineId: l.medicineId,
          qty: l.qty,
          discount: l.discount,
        })),
      });

      if (!result.ok) {
        setError(result.error ?? 'Could not complete the sale.');
        return;
      }

      setReceipt({
        invoiceNo: result.invoiceNo!,
        total: result.total!,
        saleId: result.saleId!,
      });
      setCart([]);
      setPaid('');
      setCustomer(null);
      setPrescriptionId('');
      setQuery('');
      searchRef.current?.focus();
    });
  }

  return (
    <div className="grid flex-1 gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pos-search" className="text-sm font-medium">
            Scan or search
          </label>
          <input
            id="pos-search"
            ref={searchRef}
            autoFocus
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, results.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                const row = results[highlight];
                if (row) {
                  addToCart(row);
                  setQuery('');
                }
              }
            }}
            placeholder="Barcode, brand, or generic name"
            className="border-border bg-background focus:border-primary focus:ring-primary/30 rounded-md border px-4 py-3 text-base focus:ring-2 focus:outline-none"
          />
          <p className="text-muted-foreground text-xs">
            ↑↓ to move · Enter to add · F2 payment · F4 complete · Esc back to
            search
          </p>
        </div>

        {results.length > 0 && (
          <ul className="border-border divide-border divide-y rounded-lg border">
            {results.map((row, i) => (
              <li key={row.medicine_id}>
                <button
                  type="button"
                  onClick={() => {
                    addToCart(row);
                    setQuery('');
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    'flex w-full items-center justify-between gap-4 px-4 py-2 text-left text-sm',
                    i === highlight && 'bg-muted',
                    row.saleable_on_hand <= 0 && 'opacity-50',
                  )}
                >
                  <span>
                    <span className="font-medium">{row.name}</span>
                    {row.strength && (
                      <span className="text-muted-foreground">
                        {' '}
                        {row.strength}
                      </span>
                    )}
                    <span className="text-muted-foreground block text-xs">
                      {row.generic_name ?? '—'}
                      {row.batch_no && ` · batch ${row.batch_no}`}
                      {row.expiry_date && ` · exp ${row.expiry_date}`}
                      {row.is_prescription_required && ' · Rx'}
                      {row.is_controlled && ' · controlled'}
                    </span>
                  </span>
                  <span className="text-right whitespace-nowrap">
                    <span className="block tabular-nums">
                      {row.selling_price?.toFixed(2) ?? '—'}
                    </span>
                    <span
                      className={cn(
                        'block text-xs',
                        row.saleable_on_hand <= 0
                          ? 'text-danger'
                          : 'text-muted-foreground',
                      )}
                    >
                      {row.saleable_on_hand} {row.unit}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="border-border flex-1 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Disc.</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {cart.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="text-muted-foreground px-3 py-10 text-center"
                  >
                    Scan an item to begin.
                  </td>
                </tr>
              )}
              {cart.map((line) => (
                <tr key={line.medicineId} className="border-border border-t">
                  <td className="px-3 py-2">
                    <span className="font-medium">{line.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {line.batchNo && `batch ${line.batchNo}`}
                      {line.expiryDate && ` · exp ${line.expiryDate}`}
                      {line.isControlled && ' · controlled'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.unitPrice.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min={1}
                      max={line.available}
                      step="0.001"
                      value={line.qty}
                      onChange={(e) =>
                        setCart((prev) =>
                          prev.map((l) =>
                            l.medicineId === line.medicineId
                              ? {
                                  ...l,
                                  qty: Math.min(
                                    Math.max(Number(e.target.value) || 0, 0),
                                    l.available,
                                  ),
                                }
                              : l,
                          ),
                        )
                      }
                      className="border-border bg-background w-20 rounded-md border px-2 py-1 text-right"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.discount}
                      onChange={(e) =>
                        setCart((prev) =>
                          prev.map((l) =>
                            l.medicineId === line.medicineId
                              ? {
                                  ...l,
                                  discount: Math.max(
                                    Number(e.target.value) || 0,
                                    0,
                                  ),
                                }
                              : l,
                          ),
                        )
                      }
                      className="border-border bg-background w-20 rounded-md border px-2 py-1 text-right"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {(line.qty * line.unitPrice - line.discount).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        setCart((prev) =>
                          prev.filter((l) => l.medicineId !== line.medicineId),
                        )
                      }
                      className="text-danger text-xs underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <aside className="flex flex-col gap-4">
        {receipt && (
          <div className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-lg border p-4">
            <p className="font-semibold">Sale complete</p>
            <p className="text-sm">
              Invoice <span className="font-mono">{receipt.invoiceNo}</span> ·{' '}
              {currency} {receipt.total.toFixed(2)}
            </p>
            <a
              href={`receipt/${receipt.saleId}`}
              className="text-primary text-sm underline"
            >
              Print receipt
            </a>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="border-danger/30 bg-danger/10 text-danger rounded-md border px-3 py-2 text-sm"
          >
            {error}
          </p>
        )}

        <div className="border-border flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Customer</span>
            <button
              type="button"
              onClick={() => setShowCustomer((v) => !v)}
              className="text-primary text-xs underline"
            >
              {customer ? 'Change' : 'Attach'}
            </button>
          </div>
          <p className="text-sm font-medium">
            {customer ? customer.name : 'Walk-in'}
          </p>
          {customer && customer.creditBalance > 0 && (
            <p className="text-warning text-xs">
              Owes {currency} {customer.creditBalance.toFixed(2)}
            </p>
          )}

          {showCustomer && (
            <div className="flex flex-col gap-2">
              <input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Name or phone"
                className="border-border bg-background rounded-md border px-2 py-1 text-sm"
              />
              <ul className="flex flex-col">
                {customerResults.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomer(c);
                        setShowCustomer(false);
                      }}
                      className="hover:bg-muted w-full px-2 py-1 text-left text-sm"
                    >
                      {c.name}
                      <span className="text-muted-foreground text-xs">
                        {c.phone ? ` · ${c.phone}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={async () => {
                  const created = await quickCreateCustomer(
                    slug,
                    customerQuery,
                    '',
                  );
                  if ('error' in created) {
                    setError(created.error);
                    return;
                  }
                  setCustomer({
                    id: created.id,
                    name: created.name,
                    phone: null,
                    creditBalance: 0,
                  });
                  setShowCustomer(false);
                }}
                className="border-border rounded-md border px-2 py-1 text-xs"
              >
                Add “{customerQuery || 'new customer'}” as a new customer
              </button>
              {customer && (
                <button
                  type="button"
                  onClick={() => {
                    setCustomer(null);
                    setShowCustomer(false);
                  }}
                  className="text-muted-foreground text-xs underline"
                >
                  Clear customer
                </button>
              )}
            </div>
          )}
        </div>

        {needsRx && (
          <div className="border-warning/40 bg-warning/5 flex flex-col gap-2 rounded-lg border p-4">
            <p className="text-sm font-medium">Prescription required</p>
            <p className="text-muted-foreground text-xs">
              The sale will be refused without one. Paste the prescription ID
              recorded for this customer.
            </p>
            <input
              value={prescriptionId}
              onChange={(e) => setPrescriptionId(e.target.value)}
              placeholder="Prescription ID"
              className="border-border bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
        )}

        <div className="border-border flex flex-col gap-3 rounded-lg border p-4">
          <Row label="Subtotal" value={totals.subtotal} currency={currency} />
          <Row label="Discount" value={-totals.discount} currency={currency} />
          <Row
            label={`Tax (${taxRate}%${taxMode === 'inclusive' ? ', incl.' : ''})`}
            value={totals.tax}
            currency={currency}
          />
          <div className="border-border flex items-center justify-between border-t pt-3 text-lg font-semibold">
            <span>Total</span>
            <span className="tabular-nums">
              {currency} {totals.total.toFixed(2)}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">
            Final amount is recalculated from batch prices when the sale is
            recorded.
          </p>
        </div>

        <div className="border-border flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="method" className="text-sm font-medium">
              Payment
            </label>
            <select
              id="method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="paid" className="text-sm font-medium">
              Amount received (F2)
            </label>
            <input
              id="paid"
              ref={paidRef}
              type="number"
              step="0.01"
              min="0"
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void complete();
                }
              }}
              className="border-border bg-background rounded-md border px-3 py-2 text-right text-lg tabular-nums"
            />
          </div>

          {paid !== '' && (
            <p className="text-sm">
              {change >= 0 ? 'Change' : 'Still due'}:{' '}
              <span className="font-semibold tabular-nums">
                {currency} {Math.abs(change).toFixed(2)}
              </span>
            </p>
          )}

          {method === 'credit' && !customer && (
            <p className="text-warning text-xs">
              A credit sale needs a customer to bill it to.
            </p>
          )}

          <button
            type="button"
            onClick={complete}
            disabled={
              pending || cart.length === 0 || (method === 'credit' && !customer)
            }
            className="bg-primary text-primary-foreground rounded-md px-4 py-3 font-medium disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? 'Recording…' : 'Complete sale (F4)'}
          </button>
        </div>

        {canSeeReturns && (
          <a
            href="sales"
            className="border-border rounded-md border px-3 py-2 text-center text-sm"
          >
            Sales history & returns
          </a>
        )}
      </aside>
    </div>
  );
}

function Row({
  label,
  value,
  currency,
}: {
  label: string;
  value: number;
  currency: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {currency} {value.toFixed(2)}
      </span>
    </div>
  );
}
