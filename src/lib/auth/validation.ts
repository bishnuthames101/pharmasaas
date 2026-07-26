import { z } from 'zod';
import { RESERVED_SLUGS } from '@/lib/tenant/subdomain';

/**
 * Input contracts for every auth mutation. Server actions receive untrusted
 * FormData, so nothing reaches Supabase or Postgres unparsed.
 */

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Must be at least 2 characters')
  .max(32, 'Must be 32 characters or fewer')
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/,
    'Use lowercase letters, numbers and hyphens; cannot start or end with a hyphen',
  )
  .refine((slug) => !RESERVED_SLUGS.has(slug), 'This address is reserved');

/**
 * Minimum 8 characters, matching Supabase Auth's own default. Deliberately no
 * composition rules (no "must contain a symbol"): they push people toward
 * predictable substitutions and shorter passwords, and length matters more.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Must be at least 8 characters')
  .max(72, 'Must be 72 characters or fewer'); // bcrypt truncates beyond 72

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address'));

export const signUpSchema = z.object({
  pharmacyName: z
    .string()
    .trim()
    .min(2, 'Enter the pharmacy name')
    .max(120, 'Name is too long'),
  slug: slugSchema,
  email: emailSchema,
  password: passwordSchema,
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  address: z.string().trim().max(300).optional().or(z.literal('')),
});

export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
});

export const addStaffSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(['owner', 'pharmacist', 'cashier']),
});

export const staffStatusSchema = z.object({
  userId: z.uuid(),
  isActive: z.stringbool(),
});

export const switchTenantSchema = z.object({
  tenantId: z.uuid(),
});

/** Shape returned by every auth server action, consumed by `useActionState`. */
export interface ActionResult {
  error?: string;
  /** Field-level messages keyed by form field name. */
  fieldErrors?: Record<string, string>;
  success?: string;
}

/** Collapse a ZodError into flat, field-keyed messages for the form. */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form';
    result[key] ??= issue.message;
  }
  return result;
}
