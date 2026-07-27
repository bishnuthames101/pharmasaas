'use client';

import { useActionState } from 'react';
import { settleCredit } from '@/lib/customers/actions';
import { SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export function SettleForm({
  slug,
  customerId,
  balance,
}: {
  slug: string;
  customerId: string;
  balance: number;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    settleCredit,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="customerId" value={customerId} />

      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="amount" className="text-xs font-medium">
            Amount received
          </label>
          <input
            id="amount"
            name="amount"
            type="number"
            step="0.01"
            min="0"
            max={balance}
            defaultValue={balance.toFixed(2)}
            className="border-border bg-background w-32 rounded-md border px-2 py-1 text-right text-sm"
          />
        </div>
        <SubmitButton pendingLabel="Settling…">Settle</SubmitButton>
      </div>

      {state.error && <p className="text-danger text-xs">{state.error}</p>}
      {state.success && <p className="text-primary text-xs">{state.success}</p>}
    </form>
  );
}
