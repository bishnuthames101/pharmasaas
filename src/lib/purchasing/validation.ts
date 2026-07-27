import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  phone: optionalText(40),
  email: optionalText(200),
  address: optionalText(300),
  pan_vat_no: optionalText(60),
});

export const paymentSchema = z.object({
  supplierId: z.uuid(),
  amount: z.coerce.number().positive('Enter an amount greater than zero'),
  method: optionalText(40),
  reference: optionalText(80),
  purchaseId: z
    .string()
    .optional()
    .transform((v) => (v ? v : null))
    .refine(
      (v) => v === null || z.uuid().safeParse(v).success,
      'Invalid purchase',
    ),
  notes: optionalText(300),
});

/** One goods-receipt line. Quantities may be entered in packs or units. */
export const purchaseLineSchema = z.object({
  medicine_id: z.uuid('Choose a medicine'),
  batch_no: z.string().trim().min(1, 'Batch number required').max(80),
  expiry_date: z.iso.date('Enter a valid expiry date'),
  qty: z.coerce.number().positive('Quantity must be above zero'),
  pack_mode: z.coerce.boolean().default(false),
  unit_cost: z.coerce.number().min(0),
  selling_price: z.coerce.number().min(0),
  mrp: z
    .union([z.coerce.number().min(0), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
});

export const purchaseSchema = z.object({
  supplierId: z
    .string()
    .optional()
    .transform((v) => (v ? v : null))
    .refine(
      (v) => v === null || z.uuid().safeParse(v).success,
      'Invalid supplier',
    ),
  invoiceNo: optionalText(80),
  purchaseDate: z.iso.date('Enter a valid date'),
  paid: z.coerce.number().min(0).default(0),
  lines: z.array(purchaseLineSchema).min(1, 'Add at least one line'),
});

export type PurchaseLineInput = z.infer<typeof purchaseLineSchema>;
