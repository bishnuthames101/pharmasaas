import { redirect } from 'next/navigation';
import { getTenantBySlug } from '@/lib/tenant/lookup';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { LoginForm } from './login-form';

export async function generateMetadata(props: PageProps<'/t/[tenant]/login'>) {
  const { tenant: slug } = await props.params;
  const tenant = await getTenantBySlug(slug);
  return { title: tenant ? `Sign in to ${tenant.name}` : 'Sign in' };
}

export default async function TenantLoginPage(
  props: PageProps<'/t/[tenant]/login'>,
) {
  const { tenant: slug } = await props.params;

  // Already signed in and cleared for this pharmacy — no reason to show a form.
  const access = await getTenantAccess(slug);
  if (access.ok) {
    redirect(await tenantHref(slug, '/dashboard'));
  }

  const tenant = await getTenantBySlug(slug);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{tenant?.name}</h1>
        <p className="text-muted-foreground text-sm">
          Sign in to continue to this pharmacy.
        </p>
      </div>

      <LoginForm slug={slug} />

      <p className="text-muted-foreground text-xs">
        Staff accounts are created by the pharmacy owner. If you cannot sign in,
        ask them to check your access.
      </p>
    </main>
  );
}
