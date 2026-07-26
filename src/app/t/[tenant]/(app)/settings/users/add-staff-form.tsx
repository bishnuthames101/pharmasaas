'use client';

import { useActionState } from 'react';
import { addStaff } from '@/lib/auth/actions';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
} from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export function AddStaffForm({ slug }: { slug: string }) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    addStaff,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />

      <FormError>{state.error}</FormError>
      <FormSuccess>{state.success}</FormSuccess>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Email"
          name="email"
          type="email"
          required
          autoComplete="off"
          error={state.fieldErrors?.email}
        />

        <SelectField
          label="Role"
          name="role"
          defaultValue="cashier"
          error={state.fieldErrors?.role}
          hint="Cashiers sell; pharmacists manage stock; owners manage staff."
        >
          <option value="cashier">Cashier</option>
          <option value="pharmacist">Pharmacist</option>
          <option value="owner">Owner</option>
        </SelectField>
      </div>

      <Field
        label="Temporary password"
        name="password"
        type="text"
        required
        autoComplete="off"
        hint="Shown in plain text so you can pass it on. At least 8 characters."
        error={state.fieldErrors?.password}
      />

      <div>
        <SubmitButton pendingLabel="Adding…">Add staff member</SubmitButton>
      </div>
    </form>
  );
}
