'use client';

import { useActionState, useState } from 'react';
import { setInvoiceSeq } from '@/lib/settings/actions';
import {
  Field,
  FormError,
  FormSuccess,
  SubmitButton,
} from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

/**
 * The invoice counter, kept separate from the main form and collapsed by
 * default.
 *
 * It is not an everyday setting — the reason to touch it is carrying on from a
 * paper book or a previous system. Putting it beside the tax rate would invite
 * someone to change it while editing something else.
 */
export function InvoiceSeqForm({
  slug,
  prefix,
  nextSeq,
}: {
  slug: string;
  prefix: string;
  nextSeq: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionResult, FormData>(
    setInvoiceSeq,
    {},
  );

  return (
    <section className="border-border flex flex-col gap-3 rounded-lg border p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">Invoice numbering</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            The next sale will be{' '}
            <span className="font-mono">
              {prefix}-{nextSeq}
            </span>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-primary text-sm underline"
        >
          {open ? 'Cancel' : 'Change'}
        </button>
      </div>

      {open && (
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="slug" value={slug} />

          <FormError>{state.error}</FormError>
          <FormSuccess>{state.success}</FormSuccess>

          <p className="border-warning/40 bg-warning/5 rounded-md border px-3 py-2 text-sm">
            This can only move forward. Going back would reissue numbers already
            printed on receipts, and the next sale would then fail at the
            counter.
          </p>

          <div className="max-w-xs">
            <Field
              label="Next invoice number"
              name="next_invoice_seq"
              type="number"
              min={nextSeq}
              required
              defaultValue={nextSeq}
              hint="Set this to continue from an existing invoice book."
              error={state.fieldErrors?.next_invoice_seq}
            />
          </div>

          <div>
            <SubmitButton pendingLabel="Saving…">Update</SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}
