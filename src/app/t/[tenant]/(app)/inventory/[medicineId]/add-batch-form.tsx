'use client';

import { useActionState, useState } from 'react';
import { addBatch } from '@/lib/inventory/actions';
import {
  Field,
  FormError,
  FormSuccess,
  SubmitButton,
} from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export function AddBatchForm({
  slug,
  medicineId,
  unit,
  unitsPerPack,
}: {
  slug: string;
  medicineId: string;
  unit: string;
  unitsPerPack: number;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    addBatch,
    {},
  );
  const [packMode, setPackMode] = useState(unitsPerPack > 1);
  const [qty, setQty] = useState('');

  const converted =
    packMode && qty && Number.isFinite(Number(qty))
      ? Number(qty) * unitsPerPack
      : null;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="medicineId" value={medicineId} />

      <FormError>{state.error}</FormError>
      <FormSuccess>{state.success}</FormSuccess>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Batch number"
          name="batch_no"
          required
          error={state.fieldErrors?.batch_no}
        />
        <Field
          label="Expiry date"
          name="expiry_date"
          type="date"
          required
          error={state.fieldErrors?.expiry_date}
        />
      </div>

      {unitsPerPack > 1 && (
        <label className="border-border flex items-start gap-3 rounded-md border p-3">
          <input
            type="checkbox"
            name="pack_mode"
            checked={packMode}
            onChange={(e) => setPackMode(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium">
              Quantity is in packs
            </span>
            <span className="text-muted-foreground block text-xs">
              1 pack = {unitsPerPack} {unit}. Conversion happens once, here.
            </span>
          </span>
        </label>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label={packMode ? 'Quantity (packs)' : `Quantity (${unit})`}
          name="qty"
          type="number"
          step="0.001"
          min={0}
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          hint={converted !== null ? `= ${converted} ${unit}` : undefined}
          error={state.fieldErrors?.qty}
        />
        <Field
          label={`Cost per ${unit}`}
          name="unit_cost"
          type="number"
          step="0.01"
          min={0}
          required
          hint="Visible to owners and pharmacists only."
          error={state.fieldErrors?.unit_cost}
        />
        <Field
          label={`Selling price per ${unit}`}
          name="selling_price"
          type="number"
          step="0.01"
          min={0}
          required
          error={state.fieldErrors?.selling_price}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="MRP (optional)"
          name="mrp"
          type="number"
          step="0.01"
          min={0}
        />
      </div>

      <div>
        <SubmitButton pendingLabel="Adding…">Add stock</SubmitButton>
      </div>
    </form>
  );
}
