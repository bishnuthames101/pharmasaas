'use client';

import { useActionState, useState } from 'react';
import { savePrescription } from '@/lib/customers/actions';
import { createClient } from '@/lib/supabase/client';
import {
  Field,
  FormError,
  FormSuccess,
  SelectField,
  SubmitButton,
} from '@/components/ui/form';
import type { ActionResult } from '@/lib/auth/validation';

export function PrescriptionForm({
  slug,
  customers,
}: {
  slug: string;
  customers: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    savePrescription,
    {},
  );
  const [imagePath, setImagePath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /**
   * Uploads straight from the browser to Storage.
   *
   * The path is prefixed with the tenant id, which is what the bucket policy
   * checks — a client that rewrote the prefix would simply be refused by
   * Postgres. Routing the bytes through a server action instead would double
   * the transfer for no security gain.
   */
  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const tenantId = user?.app_metadata?.tenant_id as string | undefined;
    if (!tenantId) {
      setUploadError('Session expired. Reload and try again.');
      setUploading(false);
      return;
    }

    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${tenantId}/rx/${crypto.randomUUID()}.${ext}`;

    const { error } = await supabase.storage
      .from('tenant-files')
      .upload(path, file, { upsert: false });

    if (error) {
      setUploadError(error.message);
    } else {
      setImagePath(path);
    }
    setUploading(false);
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="imagePath" value={imagePath} />

      <FormError>{state.error}</FormError>
      <FormSuccess>{state.success}</FormSuccess>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Customer" name="customerId" defaultValue="">
          <option value="">— none —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <Field label="Prescriber" name="prescriberName" />
        <Field label="Prescriber registration no." name="prescriberRegNo" />
        <Field label="Issued on" name="issuedDate" type="date" />
        <Field
          label="Refills allowed"
          name="refillsAllowed"
          type="number"
          min={0}
          max={24}
          defaultValue={0}
        />
      </div>

      <Field label="Notes" name="notes" />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="scan" className="text-sm font-medium">
          Prescription scan
        </label>
        <input
          id="scan"
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          className="text-sm"
        />
        <p className="text-muted-foreground text-xs">
          {uploading
            ? 'Uploading…'
            : imagePath
              ? 'Scan attached.'
              : 'Stored privately; only ever shared through short-lived links.'}
        </p>
        {uploadError && <p className="text-danger text-xs">{uploadError}</p>}
      </div>

      <div>
        <SubmitButton pendingLabel="Saving…">Record prescription</SubmitButton>
      </div>
    </form>
  );
}
