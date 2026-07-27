'use client';

import { useActionState } from 'react';
import { processReturn } from '@/lib/pos/returns';
import { FormError, FormSuccess, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export interface SaleLineView {
  id: string;
  name: string;
  unit: string;
  batchNo: string;
  expiryDate: string;
  qty: number;
  qtyReturned: number;
  unitPrice: number;
  total: number;
}

/**
 * Sale lines with a return quantity against each.
 *
 * Left blank by default: most returns are one item out of several, so an
 * unfilled box means "not returned" rather than requiring the operator to zero
 * out every other line.
 */
export function ReturnForm({
  slug,
  saleId,
  lines,
}: {
  slug: string;
  saleId: string;
  lines: SaleLineView[];
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    processReturn,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="saleId" value={saleId} />

      <FormError>{state.error}</FormError>
      <FormSuccess>{state.success}</FormSuccess>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Item</th>
              <th className="px-4 py-2 text-left font-medium">Batch</th>
              <th className="px-4 py-2 text-right font-medium">Sold</th>
              <th className="px-4 py-2 text-right font-medium">
                Already returned
              </th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 text-right font-medium">Return qty</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const remaining = line.qty - line.qtyReturned;
              return (
                <tr key={line.id} className="border-border border-t">
                  <td className="px-4 py-2">{line.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {line.batchNo}
                    <span className="text-muted-foreground block">
                      exp {line.expiryDate}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.qty} {line.unit}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.qtyReturned || '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.total.toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <input type="hidden" name="line.id" value={line.id} />
                    <input
                      name="line.qty"
                      type="number"
                      min={0}
                      max={remaining}
                      step="0.001"
                      defaultValue=""
                      disabled={remaining <= 0}
                      placeholder="0"
                      aria-label={`Return quantity for ${line.name}`}
                      className="border-border bg-background w-24 rounded-md border px-2 py-1 text-right disabled:opacity-40"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Returned stock goes back to the batch it was sold from, so expiry
          tracking stays accurate.
        </p>
        <SubmitButton pendingLabel="Processing…">Process return</SubmitButton>
      </div>
    </form>
  );
}
