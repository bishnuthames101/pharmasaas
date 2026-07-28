import { z } from 'zod';

/** Input contract for pharmacy settings. */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

/**
 * Invoice prefixes end up in `INV-1`, on printed receipts and in tax records,
 * so they are kept to characters that survive a thermal printer and a
 * spreadsheet without surprises.
 */
const invoicePrefix = z
  .string()
  .trim()
  .min(1, 'Enter a prefix')
  .max(12, 'Keep it to 12 characters or fewer')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9/-]*$/,
    'Letters, numbers, hyphen and slash only',
  );

export const settingsSchema = z
  .object({
    pharmacy_name: z.string().trim().min(1, 'Enter the pharmacy name').max(120),
    address: optionalText(300),
    phone: optionalText(40),
    currency: z
      .string()
      .trim()
      .min(1, 'Enter a currency code')
      .max(8)
      .transform((v) => v.toUpperCase()),
    tax_mode: z.enum(['exclusive', 'inclusive']),
    default_tax_rate: z.coerce
      .number()
      .min(0, 'Cannot be negative')
      .max(100, 'Cannot exceed 100%'),
    invoice_prefix: invoicePrefix,
    low_stock_threshold_default: z.coerce
      .number()
      .int('Whole numbers only')
      .min(0, 'Cannot be negative'),

    // Three thresholds, rendered as separate fields because "30,60,90" in one
    // box is easy to mistype and hard to validate helpfully.
    expiry_critical: z.coerce.number().int().min(1).max(3650),
    expiry_warning: z.coerce.number().int().min(1).max(3650),
    expiry_notice: z.coerce.number().int().min(1).max(3650),
  })
  .refine((v) => v.expiry_critical < v.expiry_warning, {
    message: 'Must be smaller than the second threshold',
    path: ['expiry_critical'],
  })
  .refine((v) => v.expiry_warning < v.expiry_notice, {
    message: 'Must be smaller than the third threshold',
    path: ['expiry_warning'],
  });

export type SettingsInput = z.infer<typeof settingsSchema>;

/**
 * The invoice counter is edited separately and guarded.
 *
 * Lowering it would regenerate numbers already used, and the
 * `unique (tenant_id, invoice_no)` constraint would then fail a sale — at the
 * counter, with a customer waiting. So it only ever moves forward. The reason
 * to touch it at all is carrying on from a paper book or a previous system.
 */
export const invoiceSeqSchema = z.object({
  next_invoice_seq: z.coerce
    .number()
    .int('Whole numbers only')
    .min(1, 'Must be at least 1'),
});
