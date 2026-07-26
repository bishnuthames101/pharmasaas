import { redirect } from 'next/navigation';
import { tenantHref } from '@/lib/tenant/urls';

/**
 * A tenant's root sends people to the dashboard, which is behind the auth guard
 * and will bounce them to login if they have no session. Keeping this page
 * outside the `(app)` group avoids a guard that would have to redirect to
 * itself.
 */
export default async function TenantRootPage(props: PageProps<'/t/[tenant]'>) {
  const { tenant: slug } = await props.params;
  redirect(await tenantHref(slug, '/dashboard'));
}
