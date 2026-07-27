'use client';

import { useActionState } from 'react';
import { recordPayment } from '@/lib/purchasing/actions';
import { SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

/**
 * Inline payment against a supplier's balance. The amount and the balance move
 * together inside `pay_supplier`, so a recorded payment always matches the
 * ledger.
 */
export function PaymentForm({
  slug,
  supplierId,
}: {
  slug: string;
  supplierId: string;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    recordPayment,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="supplierId" value={supplierId} />

      <div className="flex items-center gap-2">
        <input
          name="amount"
          type="number"
          step="0.01"
          min="0"
          required
          placeholder="0.00"
          aria-label="Payment amount"
          className="border-border bg-background w-24 rounded-md border px-2 py-1 text-right text-sm"
        />
        <select
          name="method"
          aria-label="Payment method"
          className="border-border bg-background rounded-md border px-2 py-1 text-sm"
        >
          <option value="cash">Cash</option>
          <option value="bank">Bank</option>
          <option value="cheque">Cheque</option>
        </select>
        <SubmitButton pendingLabel="…" className="px-3 py-1">
          Pay
        </SubmitButton>
      </div>

      {state.error && <p className="text-danger text-xs">{state.error}</p>}
      {state.success && <p className="text-primary text-xs">{state.success}</p>}
    </form>
  );
}
