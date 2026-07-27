import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTenantAccess } from '@/lib/tenant/context';
import { tenantHref } from '@/lib/tenant/urls';
import { signOut } from '@/lib/auth/actions';

/**
 * Guard for every signed-in page.
 *
 * This route group exists purely so the login page can sit outside it — a guard
 * that redirected the login page to itself would loop forever.
 *
 * Each denial reason gets the response that actually helps: no session means
 * sign in; a valid session pointed at the wrong pharmacy means switch, not sign
 * in again; membership revoked means say so plainly.
 */
export default async function TenantAppLayout(
  props: LayoutProps<'/t/[tenant]'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);

  if (!access.ok) {
    switch (access.reason) {
      case 'unauthenticated':
        redirect(await tenantHref(slug, '/login'));
      case 'wrong_active_tenant':
        // A member here, but the token points elsewhere. Sending them to the
        // chooser restamps the claim rather than bouncing them through a login
        // form that would appear to "work" and then fail again.
        redirect('/choose-pharmacy');
      case 'not_a_member':
        return (
          <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-24">
            <h1 className="text-2xl font-semibold">No access</h1>
            <p className="text-muted-foreground">
              Your account is not an active member of {access.tenant.name}. Ask
              the pharmacy owner to restore your access.
            </p>
            <form action={signOut}>
              <input type="hidden" name="slug" value={slug} />
              <button type="submit" className="text-primary text-sm underline">
                Sign in with a different account
              </button>
            </form>
          </main>
        );
      default:
        redirect(await tenantHref(slug, '/login'));
    }
  }

  const nav = [
    { href: await tenantHref(slug, '/dashboard'), label: 'Dashboard' },
    { href: await tenantHref(slug, '/pos'), label: 'Counter' },
    { href: await tenantHref(slug, '/sales'), label: 'Sales' },
    { href: await tenantHref(slug, '/inventory'), label: 'Inventory' },
    { href: await tenantHref(slug, '/purchases'), label: 'Purchases' },
    { href: await tenantHref(slug, '/customers'), label: 'Customers' },
    { href: await tenantHref(slug, '/prescriptions'), label: 'Rx' },
    { href: await tenantHref(slug, '/reports'), label: 'Reports' },
    { href: await tenantHref(slug, '/settings/users'), label: 'Staff' },
  ];

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-border print-hide border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6 py-3">
          <Link href={nav[0].href} className="font-semibold whitespace-nowrap">
            {access.tenant.name}
          </Link>

          <nav className="flex flex-1 items-center gap-4 text-sm">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground hidden sm:inline">
              {access.email} · {access.role}
            </span>
            <form action={signOut}>
              <input type="hidden" name="slug" value={slug} />
              <button
                type="submit"
                className="text-muted-foreground hover:text-foreground"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      {props.children}
    </div>
  );
}
