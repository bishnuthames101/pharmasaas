'use client';

import { useActionState, useState } from 'react';
import { receiveGoods } from '@/lib/purchasing/actions';
import { Field, FormError, SubmitButton } from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export interface MedicineOption {
  id: string;
  name: string;
  unit: string;
  units_per_pack: number;
}

export interface SupplierOption {
  id: string;
  name: string;
}

interface Line {
  key: number;
  medicineId: string;
  qty: string;
  packMode: boolean;
  unitCost: string;
}

const emptyLine = (key: number): Line => ({
  key,
  medicineId: '',
  qty: '',
  packMode: false,
  unitCost: '',
});

export function ReceiveForm({
  slug,
  medicines,
  suppliers,
  today,
}: {
  slug: string;
  medicines: MedicineOption[];
  suppliers: SupplierOption[];
  today: string;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    receiveGoods,
    {},
  );
  const [lines, setLines] = useState<Line[]>([emptyLine(0)]);
  const [nextKey, setNextKey] = useState(1);

  const byId = new Map(medicines.map((m) => [m.id, m]));

  const update = (key: number, patch: Partial<Line>) =>
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );

  // Running total so the person keying the invoice can check it against the
  // paper one before submitting, rather than after.
  const estimated = lines.reduce((sum, line) => {
    const med = byId.get(line.medicineId);
    const qty = Number(line.qty);
    const cost = Number(line.unitCost);
    if (!med || !Number.isFinite(qty) || !Number.isFinite(cost)) return sum;
    const units = line.packMode ? qty * med.units_per_pack : qty;
    return sum + units * cost;
  }, 0);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="slug" value={slug} />

      <FormError>{state.error}</FormError>

      <section className="grid gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="supplierId" className="text-sm font-medium">
            Supplier
          </label>
          <select
            id="supplierId"
            name="supplierId"
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <Field label="Supplier invoice no." name="invoiceNo" />
        <Field
          label="Date"
          name="purchaseDate"
          type="date"
          defaultValue={today}
          required
        />
        <Field
          label="Paid now"
          name="paid"
          type="number"
          step="0.01"
          min={0}
          defaultValue="0"
          hint="The rest becomes supplier balance."
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Lines</h2>

        {lines.map((line) => {
          const med = byId.get(line.medicineId);
          const units =
            med && line.packMode && line.qty
              ? Number(line.qty) * med.units_per_pack
              : null;

          return (
            <div
              key={line.key}
              className="border-border grid gap-3 rounded-lg border p-4 sm:grid-cols-6"
            >
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label className="text-xs font-medium">Medicine</label>
                <select
                  name="line.medicine_id"
                  value={line.medicineId}
                  onChange={(e) =>
                    update(line.key, { medicineId: e.target.value })
                  }
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                >
                  <option value="">— choose —</option>
                  {medicines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Batch no.</label>
                <input
                  name="line.batch_no"
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Expiry</label>
                <input
                  name="line.expiry_date"
                  type="date"
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">
                  Qty {med ? `(${line.packMode ? 'packs' : med.unit})` : ''}
                </label>
                <input
                  name="line.qty"
                  type="number"
                  step="0.001"
                  min="0"
                  value={line.qty}
                  onChange={(e) => update(line.key, { qty: e.target.value })}
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                />
                {units !== null && med && (
                  <span className="text-muted-foreground text-xs">
                    = {units} {med.unit}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">
                  Cost / {med?.unit ?? 'unit'}
                </label>
                <input
                  name="line.unit_cost"
                  type="number"
                  step="0.01"
                  min="0"
                  value={line.unitCost}
                  onChange={(e) =>
                    update(line.key, { unitCost: e.target.value })
                  }
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">
                  Sell / {med?.unit ?? 'unit'}
                </label>
                <input
                  name="line.selling_price"
                  type="number"
                  step="0.01"
                  min="0"
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">MRP</label>
                <input
                  name="line.mrp"
                  type="number"
                  step="0.01"
                  min="0"
                  className="border-border bg-background rounded-md border px-3 py-2 text-sm"
                />
              </div>

              <div className="flex items-end gap-3 sm:col-span-2">
                {med && med.units_per_pack > 1 && (
                  <label className="flex items-center gap-2 text-xs">
                    {/* A hidden twin keeps the positional index aligned with the
                        other repeated fields when the box is unticked, since an
                        unchecked checkbox submits nothing. */}
                    <input
                      type="hidden"
                      name="line.pack_mode"
                      value={line.packMode ? 'on' : 'off'}
                    />
                    <input
                      type="checkbox"
                      checked={line.packMode}
                      onChange={(e) =>
                        update(line.key, { packMode: e.target.checked })
                      }
                    />
                    Qty is in packs of {med.units_per_pack}
                  </label>
                )}
                {(!med || med.units_per_pack <= 1) && (
                  <input type="hidden" name="line.pack_mode" value="off" />
                )}

                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setLines((prev) => prev.filter((l) => l.key !== line.key))
                    }
                    className="text-danger ml-auto text-xs underline"
                  >
                    Remove line
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setLines((prev) => [...prev, emptyLine(nextKey)]);
              setNextKey((k) => k + 1);
            }}
            className="border-border rounded-md border px-3 py-2 text-sm"
          >
            Add line
          </button>

          <p className="text-sm">
            Estimated total:{' '}
            <span className="font-semibold tabular-nums">
              {estimated.toFixed(2)}
            </span>
          </p>
        </div>
      </section>

      <div>
        <SubmitButton pendingLabel="Recording…">Receive goods</SubmitButton>
      </div>
    </form>
  );
}
