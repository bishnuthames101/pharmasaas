'use client';

import { useActionState, useState } from 'react';
import { adjustStock } from '@/lib/inventory/actions';
import { ADJUSTMENT_REASONS } from '@/lib/inventory/validation';
import { SubmitButton } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/lib/auth/validation';

export interface BatchView {
  id: string;
  batch_no: string;
  expiry_date: string;
  qty_available: number;
  selling_price: number;
  /** Null for cashiers — the row is simply not readable to them. */
  cost_price: number | null;
}

function daysUntil(date: string) {
  const ms = new Date(date).getTime() - Date.now();
  return Math.floor(ms / 86_400_000);
}

export function BatchRow({
  slug,
  batch,
  unit,
  canEdit,
}: {
  slug: string;
  batch: BatchView;
  unit: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionResult, FormData>(
    adjustStock,
    {},
  );

  const days = daysUntil(batch.expiry_date);
  const expired = days < 0;

  return (
    <>
      <tr className="border-border border-t">
        <td className="px-4 py-2 font-mono text-xs">{batch.batch_no}</td>
        <td className="px-4 py-2">
          <span
            className={cn(
              expired && 'text-danger',
              days >= 0 && days <= 30 && 'text-warning',
            )}
          >
            {batch.expiry_date}
          </span>
          <span className="text-muted-foreground block text-xs">
            {expired ? `expired ${-days}d ago` : `${days}d left`}
          </span>
        </td>
        <td className="px-4 py-2 text-right tabular-nums">
          {batch.qty_available} {unit}
        </td>
        <td className="px-4 py-2 text-right tabular-nums">
          {batch.selling_price.toFixed(2)}
        </td>
        {canEdit && (
          <td className="px-4 py-2 text-right tabular-nums">
            {batch.cost_price === null ? '—' : batch.cost_price.toFixed(2)}
          </td>
        )}
        {canEdit && (
          <td className="px-4 py-2 text-right">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-primary text-xs underline"
            >
              {open ? 'Cancel' : 'Adjust'}
            </button>
          </td>
        )}
      </tr>

      {open && canEdit && (
        <tr className="bg-muted/40">
          <td colSpan={6} className="px-4 py-4">
            <form
              action={formAction}
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="batchId" value={batch.id} />

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Direction</label>
                <select
                  name="direction"
                  defaultValue="decrease"
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                >
                  <option value="decrease">Remove stock</option>
                  <option value="increase">Add stock</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Quantity ({unit})</label>
                <input
                  name="qty"
                  type="number"
                  step="0.001"
                  min="0"
                  required
                  className="border-border bg-background w-32 rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Reason</label>
                <select
                  name="reason"
                  defaultValue={expired ? 'expiry_writeoff' : 'damage'}
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                >
                  {ADJUSTMENT_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                <label className="text-xs font-medium">Note (optional)</label>
                <input
                  name="notes"
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <SubmitButton pendingLabel="Saving…">Record</SubmitButton>

              {state.error && (
                <p className="text-danger w-full text-xs">{state.error}</p>
              )}
              {state.success && (
                <p className="text-primary w-full text-xs">{state.success}</p>
              )}
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
