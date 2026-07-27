'use client';

import { useActionState } from 'react';
import { saveCustomer } from '@/lib/customers/actions';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
} from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export interface CustomerValues {
  id?: string;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  dob?: string | null;
  gender?: string | null;
  allergies?: string | null;
  notes?: string | null;
}

export function CustomerForm({
  slug,
  customer,
}: {
  slug: string;
  customer?: CustomerValues;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    saveCustomer,
    {},
  );
  const c = customer ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />
      {c.id && <input type="hidden" name="customerId" value={c.id} />}

      <FormError>{state.error}</FormError>
      <FormSuccess>{state.success}</FormSuccess>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="name"
          required
          defaultValue={c.name ?? ''}
          error={state.fieldErrors?.name}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          defaultValue={c.phone ?? ''}
        />
        <Field
          label="Date of birth"
          name="dob"
          type="date"
          defaultValue={c.dob ?? ''}
        />
        <SelectField label="Gender" name="gender" defaultValue={c.gender ?? ''}>
          <option value="">—</option>
          <option value="female">Female</option>
          <option value="male">Male</option>
          <option value="other">Other</option>
        </SelectField>
      </div>

      <Field
        label="Allergies"
        name="allergies"
        defaultValue={c.allergies ?? ''}
        hint="Shown prominently wherever this customer appears."
      />
      <Field label="Address" name="address" defaultValue={c.address ?? ''} />
      <Field label="Notes" name="notes" defaultValue={c.notes ?? ''} />

      <div>
        <SubmitButton pendingLabel="Saving…">
          {c.id ? 'Save changes' : 'Add customer'}
        </SubmitButton>
      </div>
    </form>
  );
}
