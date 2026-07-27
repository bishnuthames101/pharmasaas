'use client';

import { useActionState } from 'react';
import { setTenantStatus, type TenantOverview } from '@/lib/platform/actions';
import { SubmitButton } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/lib/auth/validation';

export function TenantRow({ tenant }: { tenant: TenantOverview }) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    setTenantStatus,
    {},
  );

  const suspended = tenant.status === 'suspended';

  return (
    <tr className="border-border border-t">
      <td className="px-4 py-2">
        <span className="font-medium">{tenant.name}</span>
        <span className="text-muted-foreground block font-mono text-xs">
          {tenant.slug}
        </span>
      </td>
      <td className="px-4 py-2">
        {new Date(tenant.createdAt).toLocaleDateString()}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">{tenant.userCount}</td>
      <td className="px-4 py-2 text-right tabular-nums">
        {tenant.medicineCount}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {tenant.saleCount}
        <span className="text-muted-foreground block text-xs">
          {tenant.salesTotal.toFixed(2)}
        </span>
      </td>
      <td className="text-muted-foreground px-4 py-2">
        {tenant.lastSaleAt
          ? new Date(tenant.lastSaleAt).toLocaleDateString()
          : '—'}
      </td>
      <td className="px-4 py-2">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs',
            suspended
              ? 'bg-danger/10 text-danger'
              : 'bg-primary/10 text-primary',
          )}
        >
          {tenant.status}
        </span>
      </td>
      <td className="px-4 py-2 text-right">
        <form action={formAction} className="flex flex-col items-end gap-1">
          <input type="hidden" name="tenantId" value={tenant.id} />
          <input
            type="hidden"
            name="status"
            value={suspended ? 'active' : 'suspended'}
          />
          <SubmitButton
            pendingLabel="…"
            className={cn(
              'px-3 py-1 text-xs',
              !suspended && 'bg-danger text-white',
            )}
          >
            {suspended ? 'Reactivate' : 'Suspend'}
          </SubmitButton>
          {state.error && (
            <span className="text-danger text-xs">{state.error}</span>
          )}
          {state.success && (
            <span className="text-primary text-xs">{state.success}</span>
          )}
        </form>
      </td>
    </tr>
  );
}
