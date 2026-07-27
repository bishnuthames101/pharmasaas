'use client';

import { useState } from 'react';
import { getPrescriptionImageUrl } from '@/lib/customers/actions';

export interface PrescriptionView {
  id: string;
  customerName: string | null;
  prescriberName: string | null;
  prescriberRegNo: string | null;
  issuedDate: string | null;
  refillsAllowed: number;
  refillsUsed: number;
  imagePath: string | null;
}

export function PrescriptionRow({
  slug,
  prescription,
}: {
  slug: string;
  prescription: PrescriptionView;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const refillsLeft = prescription.refillsAllowed - prescription.refillsUsed;

  return (
    <tr className="border-border border-t align-top">
      <td className="px-4 py-2">
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(prescription.id);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="font-mono text-xs underline"
          title="Copy ID for the counter"
        >
          {copied ? 'Copied' : `${prescription.id.slice(0, 8)}…`}
        </button>
      </td>
      <td className="px-4 py-2">{prescription.customerName ?? '—'}</td>
      <td className="px-4 py-2">
        {prescription.prescriberName ?? '—'}
        {prescription.prescriberRegNo && (
          <span className="text-muted-foreground block text-xs">
            Reg. {prescription.prescriberRegNo}
          </span>
        )}
      </td>
      <td className="px-4 py-2">{prescription.issuedDate ?? '—'}</td>
      <td className="px-4 py-2 text-right tabular-nums">
        {prescription.refillsUsed}/{prescription.refillsAllowed}
        {refillsLeft <= 0 && prescription.refillsAllowed > 0 && (
          <span className="text-danger block text-xs">exhausted</span>
        )}
      </td>
      <td className="px-4 py-2">
        {!prescription.imagePath ? (
          <span className="text-muted-foreground">—</span>
        ) : url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-primary text-xs underline"
          >
            Open (expires in 5 min)
          </a>
        ) : (
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              // Signed on demand and short-lived: a prescription scan is a
              // patient record, so no durable link to it is ever stored or
              // rendered.
              setUrl(
                await getPrescriptionImageUrl(slug, prescription.imagePath!),
              );
              setLoading(false);
            }}
            className="text-primary text-xs underline"
          >
            {loading ? 'Preparing…' : 'View scan'}
          </button>
        )}
      </td>
    </tr>
  );
}
