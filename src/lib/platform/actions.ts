'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPlatformAdmin } from '@/lib/platform/guard';
import { invalidateTenant } from '@/lib/tenant/lookup';
import type { ActionResult } from '@/lib/auth/validation';

export interface TenantOverview {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  createdAt: string;
  userCount: number;
  medicineCount: number;
  saleCount: number;
  lastSaleAt: string | null;
  salesTotal: number;
}

export async function listTenants(): Promise<TenantOverview[]> {
  // Re-checked here, not just in the layout: a layout guard does not protect a
  // server action, which is directly invocable.
  const admin = await getPlatformAdmin();
  if (!admin) return [];

  const client = createAdminClient();
  const { data, error } = await client.rpc('platform_tenant_overview');
  if (error) return [];

  const rows = (data ?? []) as {
    id: string;
    slug: string;
    name: string;
    status: string;
    plan: string;
    created_at: string;
    user_count: number;
    medicine_count: number;
    sale_count: number;
    last_sale_at: string | null;
    sales_total: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    plan: row.plan,
    createdAt: row.created_at,
    userCount: Number(row.user_count),
    medicineCount: Number(row.medicine_count),
    saleCount: Number(row.sale_count),
    lastSaleAt: row.last_sale_at,
    salesTotal: Number(row.sales_total),
  }));
}

const statusSchema = z.object({
  tenantId: z.uuid(),
  status: z.enum(['active', 'suspended']),
});

/**
 * Suspend or reactivate a pharmacy.
 *
 * Suspension takes effect on the next request: the tenant layout reads status
 * through a 60-second cache, which is invalidated here so the change is
 * immediate on this instance and at worst a minute behind on others.
 */
export async function setTenantStatus(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await getPlatformAdmin();
  if (!admin) return { error: 'Not authorised.' };

  const parsed = statusSchema.safeParse({
    tenantId: formData.get('tenantId'),
    status: formData.get('status'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };

  const client = createAdminClient();
  const { data, error } = await client.rpc('platform_set_tenant_status', {
    p_tenant_id: parsed.data.tenantId,
    p_status: parsed.data.status,
    p_actor: admin.userId,
  });

  if (error) return { error: error.message };

  const tenant = data as { slug: string } | null;
  if (tenant?.slug) invalidateTenant(tenant.slug);

  revalidatePath('/admin');
  return {
    success:
      parsed.data.status === 'suspended'
        ? 'Pharmacy suspended.'
        : 'Pharmacy reactivated.',
  };
}
