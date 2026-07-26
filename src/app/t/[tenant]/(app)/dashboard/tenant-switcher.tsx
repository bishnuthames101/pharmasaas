'use client';

import { useActionState } from 'react';
import { switchTenant } from '@/lib/auth/actions';
import { FormError, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';
import type { Membership } from '@/lib/auth/actions';

/**
 * Moves a multi-pharmacy user between their workspaces. Submitting restamps the
 * JWT claim server-side and redirects, so the destination loads with RLS
 * already resolving to the new pharmacy.
 */
export function TenantSwitcher({
  memberships,
  currentTenantId,
}: {
  memberships: Membership[];
  currentTenantId: string;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    switchTenant,
    {},
  );

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction} className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tenantId" className="text-sm font-medium">
            Pharmacy
          </label>
          <select
            id="tenantId"
            name="tenantId"
            defaultValue={currentTenantId}
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
          >
            {memberships.map((membership) => (
              <option key={membership.tenantId} value={membership.tenantId}>
                {membership.name}
              </option>
            ))}
          </select>
        </div>
        <SubmitButton pendingLabel="Switching…">Switch</SubmitButton>
      </form>
      <FormError>{state.error}</FormError>
    </div>
  );
}
