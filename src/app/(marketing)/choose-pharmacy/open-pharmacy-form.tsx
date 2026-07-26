'use client';

import { useActionState } from 'react';
import { switchTenant } from '@/lib/auth/actions';
import { FormError, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';
import type { Membership } from '@/lib/auth/actions';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
};

export function OpenPharmacyForm({ membership }: { membership: Membership }) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    switchTenant,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="tenantId" value={membership.tenantId} />
      <div className="border-border flex items-center justify-between gap-4 rounded-lg border p-4">
        <div>
          <p className="font-medium">{membership.name}</p>
          <p className="text-muted-foreground text-xs">
            {ROLE_LABEL[membership.role] ?? membership.role} · {membership.slug}
          </p>
        </div>
        <SubmitButton pendingLabel="Opening…">Open</SubmitButton>
      </div>
      <FormError>{state.error}</FormError>
    </form>
  );
}
