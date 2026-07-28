'use client';

import { useActionState } from 'react';
import { saveSettings } from '@/lib/settings/actions';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
} from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export interface SettingsValues {
  pharmacy_name: string;
  address: string;
  phone: string;
  currency: string;
  tax_mode: string;
  default_tax_rate: number;
  invoice_prefix: string;
  low_stock_threshold_default: number;
  expiry_critical: number;
  expiry_warning: number;
  expiry_notice: number;
}

export function SettingsForm({
  slug,
  settings,
  readOnly,
}: {
  slug: string;
  settings: SettingsValues;
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    saveSettings,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-8">
      <input type="hidden" name="slug" value={slug} />

      <FormError>{state.error}</FormError>
      <FormSuccess>{state.success}</FormSuccess>

      <fieldset disabled={readOnly} className="flex flex-col gap-8">
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Pharmacy details</h2>
            <p className="text-muted-foreground text-sm">
              These print at the top of every receipt.
            </p>
          </div>
          <Field
            label="Pharmacy name"
            name="pharmacy_name"
            required
            defaultValue={settings.pharmacy_name}
            error={state.fieldErrors?.pharmacy_name}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Address"
              name="address"
              defaultValue={settings.address}
            />
            <Field
              label="Phone"
              name="phone"
              type="tel"
              defaultValue={settings.phone}
            />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Money and tax</h2>
            <p className="text-muted-foreground text-sm">
              Applies to sales made from now on. Past invoices keep the figures
              they were issued with.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Currency"
              name="currency"
              required
              defaultValue={settings.currency}
              hint="Code only, e.g. NPR."
              error={state.fieldErrors?.currency}
            />
            <SelectField
              label="Tax mode"
              name="tax_mode"
              defaultValue={settings.tax_mode}
              hint={
                settings.tax_mode === 'inclusive'
                  ? 'Shelf prices already contain tax.'
                  : 'Tax is added at the till.'
              }
            >
              <option value="exclusive">Exclusive — added at the till</option>
              <option value="inclusive">
                Inclusive — built into the price
              </option>
            </SelectField>
            <Field
              label="Default tax rate %"
              name="default_tax_rate"
              type="number"
              step="0.01"
              min={0}
              max={100}
              required
              defaultValue={settings.default_tax_rate}
              hint="Used when a medicine has none of its own."
              error={state.fieldErrors?.default_tax_rate}
            />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Invoicing</h2>
            <p className="text-muted-foreground text-sm">
              Numbers are gapless and issued in order, per pharmacy.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Invoice prefix"
              name="invoice_prefix"
              required
              defaultValue={settings.invoice_prefix}
              hint={`Invoices read ${settings.invoice_prefix}-1, ${settings.invoice_prefix}-2, and so on.`}
              error={state.fieldErrors?.invoice_prefix}
            />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Alerts</h2>
            <p className="text-muted-foreground text-sm">
              The expiry board groups stock using these three windows, counted
              in days from today.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Expiring very soon"
              name="expiry_critical"
              type="number"
              min={1}
              required
              defaultValue={settings.expiry_critical}
              hint="days"
              error={state.fieldErrors?.expiry_critical}
            />
            <Field
              label="Expiring soon"
              name="expiry_warning"
              type="number"
              min={1}
              required
              defaultValue={settings.expiry_warning}
              hint="days"
              error={state.fieldErrors?.expiry_warning}
            />
            <Field
              label="On the horizon"
              name="expiry_notice"
              type="number"
              min={1}
              required
              defaultValue={settings.expiry_notice}
              hint="days"
              error={state.fieldErrors?.expiry_notice}
            />
          </div>
          <Field
            label="Default low-stock level"
            name="low_stock_threshold_default"
            type="number"
            min={0}
            required
            defaultValue={settings.low_stock_threshold_default}
            hint="Suggested when adding a medicine. Each medicine can override it."
            error={state.fieldErrors?.low_stock_threshold_default}
          />
        </section>

        {!readOnly && (
          <div>
            <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
          </div>
        )}
      </fieldset>
    </form>
  );
}
