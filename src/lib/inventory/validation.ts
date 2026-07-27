import { z } from 'zod';

/** Input contracts for inventory mutations. */

/** Empty form fields arrive as '' — treat that as "not provided", not as a value. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const optionalNumber = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === '' ? null : Number(v)))
  .refine((v) => v === null || Number.isFinite(v), 'Enter a number')
  .refine((v) => v === null || v >= 0, 'Cannot be negative');

/** HTML checkboxes submit 'on' when ticked and are absent otherwise. */
const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.literal('')])
  .optional()
  .transform((v) => v === 'on' || v === 'true');

export const medicineSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  generic_name: optionalText(200),
  composition: optionalText(400),
  strength: optionalText(80),
  form: optionalText(80),
  manufacturer: optionalText(160),
  category: optionalText(80),
  rack_location: optionalText(80),
  barcode: optionalText(80),
  unit: z.string().trim().min(1).max(24).default('pcs'),
  units_per_pack: z.coerce.number().int().min(1, 'Must be at least 1'),
  packs_per_box: z.coerce.number().int().min(1, 'Must be at least 1'),
  is_prescription_required: checkbox,
  is_controlled: checkbox,
  tax_rate: optionalNumber,
  min_stock: optionalNumber,
  max_stock: optionalNumber,
  is_active: checkbox,
});

export type MedicineInput = z.infer<typeof medicineSchema>;

export const ADJUSTMENT_REASONS = [
  { value: 'damage', label: 'Damaged' },
  { value: 'expiry_writeoff', label: 'Expiry write-off' },
  { value: 'count_correction', label: 'Stock count correction' },
  { value: 'return_to_supplier', label: 'Returned to supplier' },
  { value: 'found', label: 'Found stock' },
  { value: 'theft', label: 'Theft or loss' },
] as const;

export const adjustmentSchema = z.object({
  batchId: z.uuid(),
  direction: z.enum(['increase', 'decrease']),
  qty: z.coerce.number().positive('Enter a quantity greater than zero'),
  reason: z.enum(ADJUSTMENT_REASONS.map((r) => r.value)),
  notes: optionalText(400),
});

export const batchSchema = z.object({
  medicineId: z.uuid(),
  batch_no: z.string().trim().min(1, 'Enter a batch number').max(80),
  expiry_date: z.iso.date('Enter a valid date'),
  qty: z.coerce.number().positive('Enter a quantity greater than zero'),
  pack_mode: checkbox,
  unit_cost: z.coerce.number().min(0, 'Cannot be negative'),
  selling_price: z.coerce.number().min(0, 'Cannot be negative'),
  mrp: optionalNumber,
});
