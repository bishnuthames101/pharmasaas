import { notFound } from 'next/navigation';
import { getPlatformAdmin } from '@/lib/platform/guard';
import { listTenants } from '@/lib/platform/actions';
import { TenantRow } from './tenant-row';

export const metadata = { title: 'Platform admin' };

/**
 * Platform operator console.
 *
 * Reachable only on the root domain: a request to `{slug}.domain/admin` is
 * rewritten by the proxy to `/t/{slug}/admin`, which does not exist, so this
 * page can never render inside a tenant's namespace.
 *
 * A non-admin gets `notFound()` rather than a "forbidden" page — there is no
 * reason to confirm to a stranger that this console exists.
 */
export default async function PlatformAdminPage() {
  const admin = await getPlatformAdmin();
  if (!admin) notFound();

  const tenants = await listTenants();

  const active = tenants.filter((t) => t.status === 'active').length;
  const totalSales = tenants.reduce((sum, t) => sum + t.salesTotal, 0);
  const totalUsers = tenants.reduce((sum, t) => sum + t.userCount, 0);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Platform admin</h1>
        <p className="text-muted-foreground text-sm">
          Signed in as {admin.email}
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-4">
        {[
          { label: 'Pharmacies', value: String(tenants.length) },
          { label: 'Active', value: String(active) },
          { label: 'Staff accounts', value: String(totalUsers) },
          { label: 'Lifetime sales', value: totalSales.toFixed(2) },
        ].map((stat) => (
          <div key={stat.label} className="border-border rounded-lg border p-4">
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {stat.label}
            </p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {stat.value}
            </p>
          </div>
        ))}
      </section>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-3xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Pharmacy</th>
              <th className="px-4 py-2 text-left font-medium">Joined</th>
              <th className="px-4 py-2 text-right font-medium">Staff</th>
              <th className="px-4 py-2 text-right font-medium">Medicines</th>
              <th className="px-4 py-2 text-right font-medium">Sales</th>
              <th className="px-4 py-2 text-left font-medium">Last sale</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  No pharmacies yet.
                </td>
              </tr>
            )}
            {tenants.map((tenant) => (
              <TenantRow key={tenant.id} tenant={tenant} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground text-xs">
        This console reports counts and totals only. It does not read any
        pharmacy&apos;s records, and platform-admin status conveys no rights
        inside a pharmacy.
      </p>
    </main>
  );
}
