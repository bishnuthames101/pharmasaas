'use client';

import { useActionState } from 'react';
import { saveMedicine } from '@/lib/inventory/actions';
import { Field, FormError, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export interface MedicineValues {
  id?: string;
  name?: string | null;
  generic_name?: string | null;
  composition?: string | null;
  strength?: string | null;
  form?: string | null;
  manufacturer?: string | null;
  category?: string | null;
  rack_location?: string | null;
  barcode?: string | null;
  unit?: string | null;
  units_per_pack?: number | null;
  packs_per_box?: number | null;
  is_prescription_required?: boolean | null;
  is_controlled?: boolean | null;
  tax_rate?: number | string | null;
  min_stock?: number | string | null;
  max_stock?: number | string | null;
  is_active?: boolean | null;
}

function Check({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="border-border flex items-start gap-3 rounded-md border p-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && (
          <span className="text-muted-foreground block text-xs">{hint}</span>
        )}
      </span>
    </label>
  );
}

export function MedicineForm({
  slug,
  medicine,
}: {
  slug: string;
  medicine?: MedicineValues;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    saveMedicine,
    {},
  );
  const m = medicine ?? {};
  const isNew = !m.id;

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="slug" value={slug} />
      {m.id && <input type="hidden" name="medicineId" value={m.id} />}

      <FormError>{state.error}</FormError>

      <section className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Brand name"
          name="name"
          required
          defaultValue={m.name ?? ''}
          error={state.fieldErrors?.name}
        />
        <Field
          label="Generic name"
          name="generic_name"
          defaultValue={m.generic_name ?? ''}
          hint="Searchable alongside the brand."
        />
        <Field
          label="Composition"
          name="composition"
          defaultValue={m.composition ?? ''}
        />
        <Field
          label="Strength"
          name="strength"
          defaultValue={m.strength ?? ''}
          placeholder="500mg"
        />
        <Field
          label="Form"
          name="form"
          defaultValue={m.form ?? ''}
          placeholder="Tablet, syrup, injection"
        />
        <Field
          label="Manufacturer"
          name="manufacturer"
          defaultValue={m.manufacturer ?? ''}
        />
        <Field
          label="Category"
          name="category"
          defaultValue={m.category ?? ''}
        />
        <Field
          label="Rack location"
          name="rack_location"
          defaultValue={m.rack_location ?? ''}
          placeholder="A-3"
        />
        <Field
          label="Barcode"
          name="barcode"
          defaultValue={m.barcode ?? ''}
          error={state.fieldErrors?.barcode}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Units</h2>
        <p className="text-muted-foreground text-sm">
          Stock is counted in the smallest unit you sell. Pack sizes are used
          once, when goods are received, to convert what the supplier delivers.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Smallest unit"
            name="unit"
            defaultValue={m.unit ?? 'pcs'}
            placeholder="tablet, ml, pcs"
          />
          <Field
            label="Units per pack"
            name="units_per_pack"
            type="number"
            min={1}
            defaultValue={m.units_per_pack ?? 1}
            hint="Tablets per strip"
            error={state.fieldErrors?.units_per_pack}
          />
          <Field
            label="Packs per box"
            name="packs_per_box"
            type="number"
            min={1}
            defaultValue={m.packs_per_box ?? 1}
            hint="Strips per box"
            error={state.fieldErrors?.packs_per_box}
          />
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Tax rate %"
          name="tax_rate"
          type="number"
          step="0.01"
          min={0}
          defaultValue={m.tax_rate ?? ''}
          hint="Blank uses the pharmacy default."
          error={state.fieldErrors?.tax_rate}
        />
        <Field
          label="Minimum stock"
          name="min_stock"
          type="number"
          step="0.001"
          min={0}
          defaultValue={m.min_stock ?? ''}
          hint="Triggers the low-stock flag."
        />
        <Field
          label="Maximum stock"
          name="max_stock"
          type="number"
          step="0.001"
          min={0}
          defaultValue={m.max_stock ?? ''}
        />
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Check
          name="is_prescription_required"
          label="Prescription required"
          hint="The POS will refuse to sell without one."
          defaultChecked={m.is_prescription_required ?? false}
        />
        <Check
          name="is_controlled"
          label="Controlled substance"
          hint="Every sale is written to the controlled register."
          defaultChecked={m.is_controlled ?? false}
        />
        <Check
          name="is_active"
          label="Active"
          hint="Inactive items cannot be sold."
          defaultChecked={m.is_active ?? true}
        />
      </section>

      <div>
        <SubmitButton pendingLabel="Saving…">
          {isNew ? 'Add medicine' : 'Save changes'}
        </SubmitButton>
      </div>
    </form>
  );
}
