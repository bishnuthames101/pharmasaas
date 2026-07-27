'use client';

import { useActionState } from 'react';
import { saveSupplier } from '@/lib/purchasing/actions';
import { Field, FormError, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export function SupplierForm({ slug }: { slug: string }) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    saveSupplier,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />
      <FormError>{state.error}</FormError>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="name"
          required
          error={state.fieldErrors?.name}
        />
        <Field label="Phone" name="phone" type="tel" />
        <Field label="Email" name="email" type="email" />
        <Field label="PAN / VAT number" name="pan_vat_no" />
      </div>
      <Field label="Address" name="address" />

      <div>
        <SubmitButton pendingLabel="Saving…">Add supplier</SubmitButton>
      </div>
    </form>
  );
}
